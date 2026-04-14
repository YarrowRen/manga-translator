import base64
import io
import math
import os
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
import requests
from core.config import settings
from core.logger import get_logger
from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel

logger = get_logger(__name__)

paddleocr_available = False
try:
    if settings.PADDLE_OCR_ENABLED:
        from paddleocr import PaddleOCR
        paddleocr_available = True
        logger.info("PaddleOCR 导入成功")
    else:
        logger.info("PaddleOCR 功能已禁用，跳过导入")
except ImportError as e:
    logger.warning(f"PaddleOCR 未安装或导入失败: {e}")
except Exception as e:
    logger.error(f"PaddleOCR 导入出错: {e}")

router = APIRouter()

# OCR 实例缓存
ocr_engines: Dict[str, Any] = {}


# ---------------------------------------------------------------------------
# 几何工具
# ---------------------------------------------------------------------------

class Rectangular:
    """矩形类，用于碰撞检测"""

    def __init__(self, x: float, y: float, w: float, h: float):
        self.x0 = x
        self.y0 = y
        self.x1 = x + w
        self.y1 = y + h
        self.w = w
        self.h = h

    def collision(self, r2) -> bool:
        return self.x0 < r2.x1 and self.y0 < r2.y1 and self.x1 > r2.x0 and self.y1 > r2.y0

    def distance_to(self, other) -> float:
        cx1 = (self.x0 + self.x1) / 2
        cy1 = (self.y0 + self.y1) / 2
        cx2 = (other.x0 + other.x1) / 2
        cy2 = (other.y0 + other.y1) / 2
        return math.sqrt((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2)

    def expand(self, expand_ratio: float = 1.5):
        ew = self.w * expand_ratio - self.w
        eh = self.h * expand_ratio - self.h
        return Rectangular(self.x0 - ew / 2, self.y0 - eh / 2, self.w + ew, self.h + eh)


def _convex_hull(points: List[List[float]]) -> List[List[float]]:
    """计算点集的凸包，返回顶点列表"""
    if len(points) < 3:
        return points
    pts = np.array(points, dtype=np.float32).reshape(-1, 1, 2)
    hull = cv2.convexHull(pts)
    return [[float(p[0][0]), float(p[0][1])] for p in hull]


class DialogMerger:
    """对话框合并器"""

    def __init__(self, expand_ratio: float = 1.2, max_distance: float = 30.0, min_group_size: int = 2):
        self.expand_ratio = expand_ratio
        self.max_distance = max_distance
        self.min_group_size = min_group_size

    @staticmethod
    def bbox_to_rect(bbox: List[float]) -> Rectangular:
        x1, y1, x2, y2 = bbox
        return Rectangular(x1, y1, x2 - x1, y2 - y1)

    def _find_nearby_texts(self, rect: Rectangular, all_rects: List[Tuple[Rectangular, int]], used: set) -> List[int]:
        nearby = []
        expanded = rect.expand(expand_ratio=self.expand_ratio)
        for other_rect, idx in all_rects:
            if idx in used:
                continue
            if expanded.collision(other_rect) or rect.distance_to(other_rect) <= self.max_distance:
                nearby.append(idx)
        return nearby

    def _find_connected_texts(self, rect: Rectangular, rects: List[Tuple[Rectangular, int]], used: set, group: List[int]):
        nearby = self._find_nearby_texts(rect, rects, used)
        for idx in nearby:
            if idx not in used:
                group.append(idx)
                used.add(idx)
                nearby_rect = next(r for r, i in rects if i == idx)
                self._find_connected_texts(nearby_rect, rects, used, group)

    def merge_ocr_results(self, ocr_results: List[Dict]) -> List[Dict]:
        if not ocr_results:
            return []

        logger.info(f"开始合并对话框，原始文本区域数量: {len(ocr_results)}")

        rectangles = [(self.bbox_to_rect(r["bbox"]), i) for i, r in enumerate(ocr_results)]
        rectangles.sort(key=lambda x: x[0].w * x[0].h, reverse=True)

        merged_groups = []
        used = set()

        for rect, original_index in rectangles:
            if original_index in used:
                continue
            group = [original_index]
            used.add(original_index)
            self._find_connected_texts(rect, rectangles, used, group)
            merged_groups.append(group)

        merged_results = []
        for group_indices in merged_groups:
            if len(group_indices) >= self.min_group_size:
                group_data = []
                for idx in group_indices:
                    result = ocr_results[idx]
                    center_x = (result["bbox"][0] + result["bbox"][2]) / 2
                    group_data.append((idx, center_x, result))
                group_data.sort(key=lambda x: x[1], reverse=True)  # 右→左

                merged_text = " ".join([item[2]["text"] for item in group_data])
                merged_confidence = sum(item[2]["confidence"] for item in group_data) / len(group_data)
                all_x = [item[2]["bbox"][0] for item in group_data] + [item[2]["bbox"][2] for item in group_data]
                all_y = [item[2]["bbox"][1] for item in group_data] + [item[2]["bbox"][3] for item in group_data]

                # 凸包合并多边形
                all_pts = []
                for item in group_data:
                    poly = item[2].get("polygon")
                    if poly:
                        all_pts.extend(poly)
                    else:
                        b = item[2]["bbox"]
                        all_pts.extend([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]])
                merged_polygon = _convex_hull(all_pts)

                merged_results.append({
                    "text": merged_text,
                    "confidence": merged_confidence,
                    "bbox": [min(all_x), min(all_y), max(all_x), max(all_y)],
                    "polygon": merged_polygon,
                    "is_merged": True,
                    "original_count": len(group_indices),
                    "original_texts": [item[2]["text"] for item in group_data],
                })
            else:
                for idx in group_indices:
                    r = ocr_results[idx]
                    merged_results.append({
                        "text": r["text"],
                        "confidence": r["confidence"],
                        "bbox": r["bbox"],
                        "polygon": r.get("polygon"),
                        "is_merged": False,
                        "original_count": 1,
                        "original_texts": [r["text"]],
                    })

        merged_results.sort(key=lambda x: x["confidence"], reverse=True)
        logger.info(f"对话框合并完成，生成 {len(merged_results)} 个文本区域")
        return merged_results


# ---------------------------------------------------------------------------
# Pydantic 模型
# ---------------------------------------------------------------------------

class OCRRequest(BaseModel):
    image_url: str                                      # base64 data URL 或 http(s) URL
    language: str = "japan"
    confidence_threshold: Optional[float] = 0.7
    det_limit_type: Optional[str] = "max"
    det_limit_side_len: Optional[int] = 960
    use_doc_orientation_classify: Optional[bool] = False
    use_doc_unwarping: Optional[bool] = False


class BatchTranslateRequest(BaseModel):
    texts: List[str]
    source_language: str = "japan"
    target_language: str = "zh"


class OCRResult(BaseModel):
    text: str
    confidence: float
    bbox: List[float]                              # AABB，用于前端框绘制
    polygon: Optional[List[List[float]]] = None   # 精确多边形，用于 inpaint
    is_merged: Optional[bool] = False
    original_count: Optional[int] = 1
    original_texts: Optional[List[str]] = None


class OCRResponse(BaseModel):
    success: bool
    results: List[OCRResult] = []
    error: Optional[str] = None
    processing_time: Optional[float] = None


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------

def get_ocr_engine(request: OCRRequest) -> Any:
    if not paddleocr_available:
        raise HTTPException(status_code=503, detail="OCR 服务未启用或 PaddleOCR 未安装")

    cache_key = f"{request.language}_{request.det_limit_type}_{request.det_limit_side_len}_{request.use_doc_orientation_classify}_{request.use_doc_unwarping}"
    if cache_key not in ocr_engines:
        try:
            ocr_engines[cache_key] = PaddleOCR(
                lang=request.language,
                text_det_limit_type=request.det_limit_type,
                text_det_limit_side_len=request.det_limit_side_len,
                use_doc_orientation_classify=request.use_doc_orientation_classify,
                use_doc_unwarping=request.use_doc_unwarping,
            )
            logger.info(f"OCR 引擎初始化完成: {cache_key}")
        except Exception as e:
            logger.error(f"OCR 引擎初始化失败 ({cache_key}): {e}")
            raise HTTPException(status_code=500, detail=f"OCR 引擎初始化失败: {str(e)}")
    return ocr_engines[cache_key]


def load_image_to_temp(image_url: str) -> str:
    """
    将图片加载到临时文件。
    支持：
      - base64 data URL（data:image/...;base64,...）
      - 本地文件路径
      - http(s) URL
    返回临时文件路径（调用方负责清理）。
    """
    # base64 data URL
    if image_url.startswith("data:"):
        try:
            header, data = image_url.split(",", 1)
            ext = header.split(";")[0].split("/")[-1]
            if ext.lower() in ("jpeg", "jpg"):
                ext = "jpg"
            elif ext.lower() == "png":
                ext = "png"
            else:
                ext = "jpg"
            image_bytes = base64.b64decode(data)
            with tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}") as tmp:
                tmp.write(image_bytes)
                return tmp.name
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"base64 图片解码失败: {str(e)}")

    # 本地文件
    if os.path.exists(image_url):
        return image_url

    # 外部 URL
    try:
        headers = {
            "User-Agent": "Mozilla/5.0",
        }
        response = requests.get(image_url, headers=headers, timeout=30, stream=True)
        response.raise_for_status()
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
            for chunk in response.iter_content(chunk_size=8192):
                tmp.write(chunk)
            return tmp.name
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=400, detail=f"图片下载失败: {str(e)}")


def convert_image_format(image_path: str) -> str:
    """将不受支持的图像格式转换为 JPEG"""
    try:
        with Image.open(image_path) as img:
            if img.format in ["JPEG", "JPG", "PNG", "BMP"]:
                return image_path
            if img.mode in ("RGBA", "LA"):
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[-1])
                img = background
            elif img.mode != "RGB":
                img = img.convert("RGB")
            with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
                img.save(tmp, "JPEG", quality=95)
                return tmp.name
    except Exception:
        return image_path


# ---------------------------------------------------------------------------
# 翻译辅助
# ---------------------------------------------------------------------------

async def translate_japanese_to_chinese_batch(texts: List[str]) -> List[str]:
    import json
    from services.translation_service import translation_service

    input_data = {str(i + 1): text for i, text in enumerate(texts)}
    manga_prompt = (
        """**你的身份**

* 你是"日→中漫画翻译 agent"。你的唯一目标：在理解语境的前提下，把可能含有 OCR 错误的日文文本**纠正后**准确翻译为自然流畅的**简体中文**。
* 不进行创作与删改，不做剧透或点评，不自行审查或弱化用词；只做纠错与忠实翻译。

## 输入格式

```json
{
  "1": "日文文本1",
  "2": "日文文本2"
}
```

## 输出格式

只返回对应中文的 JSON：

```json
{
  "1": "中文翻译1",
  "2": "中文翻译2"
}
```

## 翻译流程

1. **纠错清洗** — 修正 OCR 错误，恢复自然语序
2. **语境判定** — 判别对白/独白/旁白/拟声词
3. **术语与称谓** — さん→先生，ちゃん→小X，くん→君，様→大人，先輩→前辈
4. **翻译策略** — 忠实准确，中文口语自然，保留粗口与俚语力度
5. **拟声词** — `原文（中文释义）` 格式
6. **不确定性** — 模糊处加 `〔? 备选：…〕`

## 输出要求

* 仅输出中文译文 JSON，不输出原文或过程说明。
* 标点使用中文全角，省略号统一"……"。

请翻译：

"""
        + json.dumps(input_data, ensure_ascii=False)
    )

    result = translation_service.translate_batch_with_prompt(manga_prompt)
    if not result.get("success", False):
        logger.error(f"翻译服务失败: {result.get('error')}")
        return texts

    translation_text = result.get("translation", "{}")
    try:
        cleaned = translation_text.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned.replace("```json", "").replace("```", "").strip()
        elif cleaned.startswith("```"):
            cleaned = cleaned.replace("```", "").strip()
        translation_json = json.loads(cleaned)
        return [translation_json.get(str(i + 1), texts[i]) for i in range(len(texts))]
    except json.JSONDecodeError:
        start = translation_text.find("{")
        end = translation_text.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                translation_json = json.loads(translation_text[start:end])
                return [translation_json.get(str(i + 1), texts[i]) for i in range(len(texts))]
            except Exception:
                pass
        return texts


# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------

@router.post("/recognize", response_model=OCRResponse)
async def recognize_text(request: OCRRequest):
    """OCR 文本识别（接受 base64 data URL 或 http URL）"""
    if not settings.PADDLE_OCR_ENABLED:
        raise HTTPException(status_code=503, detail="PaddleOCR 服务已禁用，请在 .env 中设置 PADDLE_OCR_ENABLED=true")

    temp_files = []
    start_time = time.time()

    try:
        ocr_engine = get_ocr_engine(request)

        image_path = load_image_to_temp(request.image_url)
        if not os.path.exists(request.image_url):
            temp_files.append(image_path)

        converted_path = convert_image_format(image_path)
        if converted_path != image_path:
            temp_files.append(converted_path)

        logger.info(f"开始 OCR 识别，语言: {request.language}")
        ocr_results = ocr_engine.ocr(converted_path)

        raw_results = []
        if ocr_results and len(ocr_results) > 0:
            result_dict = ocr_results[0]
            rec_texts = result_dict.get("rec_texts", [])
            rec_scores = result_dict.get("rec_scores", [])
            rec_polys = result_dict.get("rec_polys", [])

            for text, confidence, bbox_points in zip(rec_texts, rec_scores, rec_polys):
                if text and text.strip() and confidence >= request.confidence_threshold:
                    x_coords = [p[0] for p in bbox_points]
                    y_coords = [p[1] for p in bbox_points]
                    polygon = [[float(p[0]), float(p[1])] for p in bbox_points]
                    raw_results.append({
                        "text": text,
                        "confidence": confidence,
                        "bbox": [float(min(x_coords)), float(min(y_coords)), float(max(x_coords)), float(max(y_coords))],
                        "polygon": polygon,
                    })

        merger = DialogMerger()
        merged = merger.merge_ocr_results(raw_results)

        merged.sort(key=lambda r: (r["bbox"][1], -r["bbox"][2]))

        results = [
            OCRResult(
                text=r["text"],
                confidence=r["confidence"],
                bbox=r["bbox"],
                polygon=r.get("polygon"),
                is_merged=r.get("is_merged", False),
                original_count=r.get("original_count", 1),
                original_texts=r.get("original_texts", [r["text"]]),
            )
            for r in merged
        ]

        processing_time = time.time() - start_time
        logger.info(f"OCR 识别完成，{len(results)} 个区域，耗时 {processing_time:.2f}s")
        return OCRResponse(success=True, results=results, processing_time=processing_time)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OCR 识别失败: {e}")
        raise HTTPException(status_code=500, detail=f"OCR 识别失败: {str(e)}")
    finally:
        for f in temp_files:
            try:
                if os.path.exists(f):
                    os.remove(f)
            except Exception:
                pass


@router.post("/translate/batch")
async def translate_batch(request: BatchTranslateRequest):
    """批量翻译文本"""
    try:
        if request.source_language == "japan" and request.target_language == "zh":
            translations = await translate_japanese_to_chinese_batch(request.texts)
            return {
                "success": True,
                "translations": translations,
                "source_language": request.source_language,
                "target_language": request.target_language,
                "translation_method": "japanese_manga_prompt",
            }
        return {
            "success": True,
            "translations": request.texts,
            "source_language": request.source_language,
            "target_language": request.target_language,
            "translation_method": "passthrough",
        }
    except Exception as e:
        logger.error(f"批量翻译失败: {e}")
        raise HTTPException(status_code=500, detail=f"翻译失败: {str(e)}")


@router.get("/status")
async def get_ocr_status():
    return {
        "paddle_ocr_enabled": settings.PADDLE_OCR_ENABLED,
        "paddleocr_available": paddleocr_available,
        "active_engines": list(ocr_engines.keys()),
        "supported_languages": ["japan", "ch", "en", "chinese_cht"],
    }


# ---------------------------------------------------------------------------
# Inpainting
# ---------------------------------------------------------------------------

class InpaintRequest(BaseModel):
    image_url: str                                    # base64 data URL
    bboxes: List[List[float]]                         # [[x1,y1,x2,y2], ...]，用于兜底
    polygons: Optional[List[Optional[List[List[float]]]]] = None  # 精确多边形，与 bboxes 一一对应
    padding: int = 2                                  # 膨胀像素（像素级遮罩已精确，不需要太大）


def _sample_background(img_bgr: np.ndarray, x1: int, y1: int, x2: int, y2: int, border: int = 20) -> tuple[bool, np.ndarray]:
    """
    采样 bbox 外围像素环，判断背景是否均匀。
    border=20 确保采样能跳出气泡框内部，得到真实页面背景色。
    返回 (is_simple, mean_color_bgr)
    """
    h, w = img_bgr.shape[:2]
    samples = []
    for x in range(max(0, x1), min(w, x2)):
        for dy in range(border):
            if y1 - dy - 1 >= 0:
                samples.append(img_bgr[y1 - dy - 1, x])
            if y2 + dy < h:
                samples.append(img_bgr[y2 + dy, x])
    for y in range(max(0, y1), min(h, y2)):
        for dx in range(border):
            if x1 - dx - 1 >= 0:
                samples.append(img_bgr[y, x1 - dx - 1])
            if x2 + dx < w:
                samples.append(img_bgr[y, x2 + dx])

    if not samples:
        return True, np.array([255, 255, 255], dtype=np.uint8)

    arr = np.array(samples, dtype=np.float32)
    mean_color = np.mean(arr, axis=0).astype(np.uint8)
    # 放宽阈值至 500：更大的采样环自然方差更高，避免纹理背景被误判为复杂
    is_simple = float(np.var(arr)) < 500
    return is_simple, mean_color


def _build_region_mask(polygon: Optional[List[List[float]]],
                       bbox: List[float],
                       h: int, w: int) -> np.ndarray:
    """
    构建文字区域遮罩（覆盖整个多边形/bbox 区域）。
    直接填充整个区域，不做 Otsu 细化——背景色填充时无需区分墨水像素，
    且避免了 Otsu 在彩色背景下将背景误判为墨水的问题。
    """
    mask = np.zeros((h, w), dtype=np.uint8)
    if polygon and len(polygon) >= 3:
        pts = np.array(polygon, dtype=np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(mask, [pts], 255)
    else:
        rx1 = max(0, int(bbox[0]))
        ry1 = max(0, int(bbox[1]))
        rx2 = min(w, int(bbox[2]))
        ry2 = min(h, int(bbox[3]))
        mask[ry1:ry2, rx1:rx2] = 255
    return mask


def inpaint_image(img_bgr: np.ndarray,
                  bboxes: List[List[float]],
                  polygons: Optional[List[Optional[List[List[float]]]]] = None,
                  padding: int = 2) -> np.ndarray:
    """
    文字消除主函数。
    对每个区域：
      - 构建整个多边形遮罩（不做 Otsu 细化，避免彩色背景下的误判）
      - 均匀背景 → 用采样均值色填充整个区域
      - 复杂背景 → cv2.inpaint Telea 算法重建纹理
    采样范围扩大至 20px，确保能跳出气泡框内部，得到真实页面背景色。
    """
    h, w = img_bgr.shape[:2]
    result = img_bgr.copy()

    simple_fills: List[tuple] = []    # (mask, color)
    complex_mask = np.zeros((h, w), dtype=np.uint8)

    for i, bbox in enumerate(bboxes):
        poly = (polygons[i] if polygons and i < len(polygons) else None)

        region_mask = _build_region_mask(poly, bbox, h, w)
        if not region_mask.any():
            continue

        x1 = max(0, int(bbox[0]))
        y1 = max(0, int(bbox[1]))
        x2 = min(w, int(bbox[2]))
        y2 = min(h, int(bbox[3]))
        is_simple, mean_color = _sample_background(img_bgr, x1, y1, x2, y2)

        if is_simple:
            simple_fills.append((region_mask, mean_color))
        else:
            complex_mask = cv2.bitwise_or(complex_mask, region_mask)

    # 1. 均匀背景：直接填均值色
    for mask, color in simple_fills:
        result[mask > 0] = color

    # 2. 复杂背景：一次性 inpaint（inpaintRadius 增大以处理较大区域）
    if complex_mask.any():
        result = cv2.inpaint(result, complex_mask, inpaintRadius=20, flags=cv2.INPAINT_TELEA)

    return result


def ndarray_to_base64_png(img_bgr: np.ndarray) -> str:
    """将 BGR ndarray 编码为 base64 PNG data URL"""
    success, buf = cv2.imencode(".png", img_bgr)
    if not success:
        raise ValueError("图像编码失败")
    b64 = base64.b64encode(buf.tobytes()).decode("utf-8")
    return f"data:image/png;base64,{b64}"


# /inpaint — MOVED TO FRONTEND (src/services/inpaintService.ts)
# @router.post("/inpaint")
# async def inpaint_text(request: InpaintRequest): ...
