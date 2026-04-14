# MangaTrans

漫画翻译工作台。上传本地图片，自动 OCR 识别文字、LLM 批量翻译、智能消除原文、将译文回填至图片。

## 功能

- **OCR 识别**：支持本地后端（PaddleOCR）和云端 API（PaddleOCR 官方 PP-OCRv5），自动合并相邻对话框
- **LLM 批量翻译**：OpenAI 兼容接口，直接从前端调用，支持 OpenAI、DeepSeek、通义千问等
- **文字消除**：前端 Web Worker + OpenCV.js，多边形掩码精确还原背景
- **文字替换**：二分查找自适应字体大小，译文完整填入原文区域
- **一键流程**：OCR → 翻译 → 消除 → 替换，一次点击完成
- **批量处理**：支持整个文件夹批量加载，页码导航
- **数据缓存**：OCR 结果和译文持久化到 localStorage（24h），消除图片存入 sessionStorage

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python · FastAPI · PaddleOCR（可选）· OpenCV · OpenAI SDK |
| 前端 | React · TypeScript · Vite · Tailwind CSS v4 |
| OCR 云端 | PaddleOCR 官方 API（PP-OCRv5），前端直调，后端零依赖 |
| 存储 | localStorage（配置/OCR/译文）· sessionStorage（消除图）· 内存（原图） |

## 快速开始

### 后端

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env   # 填入 LLM_API_KEY 和 LLM_BASE_URL
python main.py
# 服务启动在 http://localhost:5002
```

OCR 本地模式需额外安装（可选）：

```bash
pip install paddlepaddle paddleocr opencv-contrib-python numpy pyclipper shapely
# 并在 .env 中设置 PADDLE_OCR_ENABLED=true
```

### 前端

```bash
cd frontend
npm install
npm run dev
# 访问 http://localhost:5173
```

## 配置

访问 `http://localhost:5173/settings` 进行配置。

### LLM 配置

| 字段 | 说明 | 示例 |
|------|------|------|
| API Base URL | OpenAI 兼容接口地址 | `https://api.openai.com/v1` |
| API Key | 接口密钥 | `sk-...` |
| 模型 | 模型名称 | `gpt-4o-mini` |

### OCR 配置

| 字段 | 说明 |
|------|------|
| 识别方式 | **本地后端**：调用后端 PaddleOCR（需启动后端并启用 OCR）<br>**云端 API**：直接调用 PaddleOCR 官方 API，无需本地安装任何 OCR 依赖 |
| API Token | 云端模式专用，从 [AI Studio](https://aistudio.baidu.com) 获取 |
| 模型 | 云端模式专用，默认 `PP-OCRv5` |

> 云端模式下翻译和消除仍在本地/前端完成，仅 OCR 识别步骤调用官方 API。

## 项目结构

```
manga-trans/
├── backend/
│   ├── main.py                        # FastAPI 入口，端口 5002
│   ├── requirements.txt
│   ├── .env.example
│   └── app/
│       ├── core/config.py             # 环境变量配置
│       ├── api/
│       │   ├── ocr.py                 # OCR 识别 / 文字消除接口
│       │   └── settings.py
│       └── services/
│           └── translation_service.py
└── frontend/
    └── src/
        ├── components/
        │   ├── Workbench.tsx          # 主翻译工作台
        │   └── SettingsPanel.tsx      # LLM / OCR 配置页
        ├── services/
        │   ├── llmConfig.ts           # LLM 配置（localStorage）
        │   ├── ocrConfig.ts           # OCR 配置（localStorage）
        │   ├── ocrService.ts          # OCR 入口（本地/云端路由）
        │   ├── translationService.ts  # LLM 翻译（前端直调）
        │   └── inpaintService.ts      # 文字消除（Web Worker + OpenCV.js）
        └── store/
            ├── workbenchContext.tsx   # 全局状态
            └── storage.ts             # 持久化工具
```

## 后端 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/ocr/recognize` | 本地 OCR 识别（base64 输入，需启用 PaddleOCR） |
| POST | `/api/ocr/inpaint` | 文字消除，返回 base64 图片 |
| GET  | `/api/ocr/status` | OCR 服务状态 |

> 翻译接口已迁移至前端直调 LLM，云端 OCR 也直接在前端完成，无需后端转发。

## 环境变量

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your_api_key_here
LLM_MODEL=gpt-4o-mini
PADDLE_OCR_ENABLED=false   # 本地 OCR 模式：设为 true 并安装 PaddleOCR 依赖
PORT=5002
LOG_LEVEL=INFO
```
