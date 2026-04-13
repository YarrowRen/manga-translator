"""
AI 翻译服务模块 - OpenAI 兼容接口
"""

from openai import OpenAI
from core.config import settings
from core.logger import get_logger

logger = get_logger(__name__)


class TranslationService:
    """AI 翻译服务类，管理 API 调用"""

    def __init__(self):
        self.client = None
        self.is_initialized = False

    def _get_config(self):
        """从 settings 中动态读取最新配置（支持热更新）"""
        return {
            "base_url": settings.LLM_BASE_URL,
            "api_key": settings.LLM_API_KEY,
            "model": settings.LLM_MODEL,
        }

    def initialize(self, force: bool = False):
        """初始化 API 客户端"""
        if self.is_initialized and not force:
            return True

        cfg = self._get_config()
        if not cfg["api_key"]:
            logger.error("未配置 LLM_API_KEY")
            return False

        try:
            self.client = OpenAI(
                base_url=cfg["base_url"],
                api_key=cfg["api_key"],
            )
            self.is_initialized = True
            logger.info(f"翻译服务初始化成功 - 模型: {cfg['model']}, API: {cfg['base_url']}")
            return True
        except Exception as e:
            logger.error(f"翻译服务初始化失败: {e}")
            return False

    def translate_batch_with_prompt(self, prompt_text: str) -> dict:
        """
        使用自定义 prompt 进行翻译（批量日译中专用）

        Args:
            prompt_text: 完整的 prompt 文本（包括待翻译内容）

        Returns:
            {"success": bool, "translation": str, "error": str}
        """
        if not self.is_initialized:
            if not self.initialize():
                return {"success": False, "translation": "", "error": "翻译服务未初始化，请先在设置页配置 LLM"}

        cfg = self._get_config()
        try:
            logger.info("开始批量翻译")
            response = self.client.chat.completions.create(
                model=cfg["model"],
                messages=[{"role": "user", "content": prompt_text}],
                temperature=0.3,
                max_tokens=4000,
            )
            if response.choices and len(response.choices) > 0:
                translation = response.choices[0].message.content.strip()
                logger.info(f"批量翻译完成，结果长度: {len(translation)}")
                return {"success": True, "translation": translation, "error": ""}
            else:
                return {"success": False, "translation": "", "error": "API 响应格式错误"}
        except Exception as e:
            logger.error(f"翻译请求失败: {e}")
            return {"success": False, "translation": "", "error": f"翻译失败: {str(e)}"}

    def test_connection(self) -> dict:
        """测试 LLM 连接"""
        if not self.initialize(force=True):
            return {"success": False, "error": "初始化失败，请检查 API Key 配置"}

        cfg = self._get_config()
        try:
            response = self.client.chat.completions.create(
                model=cfg["model"],
                messages=[{"role": "user", "content": "Hi"}],
                max_tokens=5,
            )
            return {"success": True, "model": cfg["model"], "base_url": cfg["base_url"]}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def get_status(self) -> dict:
        cfg = self._get_config()
        return {
            "is_initialized": self.is_initialized,
            "api_key_set": bool(cfg["api_key"]),
            "model": cfg["model"],
            "base_url": cfg["base_url"],
        }


# 全局翻译服务实例
translation_service = TranslationService()
