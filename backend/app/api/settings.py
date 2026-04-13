"""
LLM 配置管理接口
支持读取、写入 .env 文件，以及连接测试
"""

import os
from pathlib import Path

from core.config import settings
from core.logger import get_logger
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = get_logger(__name__)
router = APIRouter()

# .env 文件路径（backend 根目录）
ENV_FILE = Path(__file__).parent.parent.parent / ".env"


class LLMConfig(BaseModel):
    base_url: str
    api_key: str
    model: str


def _read_env_file() -> dict:
    """读取 .env 文件为字典"""
    env_vars = {}
    if ENV_FILE.exists():
        with open(ENV_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env_vars[key.strip()] = value.strip()
    return env_vars


def _write_env_file(env_vars: dict):
    """将字典写入 .env 文件"""
    lines = []
    for key, value in env_vars.items():
        lines.append(f"{key}={value}")
    with open(ENV_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def _reload_settings(env_vars: dict):
    """将最新配置同步到 settings 对象（热更新）"""
    if "LLM_BASE_URL" in env_vars:
        settings.LLM_BASE_URL = env_vars["LLM_BASE_URL"]
    if "LLM_API_KEY" in env_vars:
        settings.LLM_API_KEY = env_vars["LLM_API_KEY"]
    if "LLM_MODEL" in env_vars:
        settings.LLM_MODEL = env_vars["LLM_MODEL"]

    # 重置翻译服务，使其使用新配置
    from services.translation_service import translation_service
    translation_service.is_initialized = False
    translation_service.client = None


@router.get("")
async def get_settings():
    """返回当前 LLM 配置（api_key 脱敏）"""
    return {
        "base_url": settings.LLM_BASE_URL,
        "api_key": "***" if settings.LLM_API_KEY else "",
        "api_key_set": bool(settings.LLM_API_KEY),
        "model": settings.LLM_MODEL,
    }


@router.post("")
async def update_settings(config: LLMConfig):
    """更新 LLM 配置并写入 .env 文件"""
    try:
        env_vars = _read_env_file()

        env_vars["LLM_BASE_URL"] = config.base_url
        env_vars["LLM_MODEL"] = config.model
        if config.api_key and config.api_key != "***":
            env_vars["LLM_API_KEY"] = config.api_key

        _write_env_file(env_vars)
        _reload_settings(env_vars)

        logger.info(f"LLM 配置已更新: base_url={config.base_url}, model={config.model}")
        return {"success": True, "message": "配置已保存"}
    except Exception as e:
        logger.error(f"保存配置失败: {e}")
        raise HTTPException(status_code=500, detail=f"保存配置失败: {str(e)}")


@router.post("/test")
async def test_connection():
    """测试 LLM 连接"""
    from services.translation_service import translation_service
    result = translation_service.test_connection()
    if result["success"]:
        return {"success": True, "message": f"连接成功，模型: {result['model']}"}
    else:
        raise HTTPException(status_code=400, detail=result.get("error", "连接失败"))
