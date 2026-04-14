"""
LLM 配置管理接口 — 已迁移至前端 (src/services/llmConfig.ts + SettingsPanel.tsx)
配置现在保存在用户浏览器 localStorage，不再需要后端接口。
此文件保留供参考，路由注册已从 main.py 中移除。
"""

# from fastapi import APIRouter, HTTPException
# ...所有端点已移除，见 frontend/src/services/llmConfig.ts

from fastapi import APIRouter
router = APIRouter()  # 空路由，保持 main.py import 不报错
