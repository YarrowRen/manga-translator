import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    # LLM 翻译配置
    LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
    LLM_API_KEY = os.getenv("LLM_API_KEY", "")
    LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

    # OCR 配置
    PADDLE_OCR_ENABLED = os.getenv("PADDLE_OCR_ENABLED", "false").lower() in ("true", "1", "yes", "on")

    # 日志配置
    LOG_DIR = os.getenv("LOG_DIR", "logs")
    LOG_FILE = os.getenv("LOG_FILE", "app.log")
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

    # 服务端口
    PORT = int(os.getenv("PORT", 5002))

    # CORS
    ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")


settings = Settings()
