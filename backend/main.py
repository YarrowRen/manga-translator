import sys
import os

# 将 app 目录加入 Python 路径，使内部模块可以用 `from core.xxx` 导入
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "app"))

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import ocr
# settings API removed — LLM config now managed by frontend localStorage
from core.config import settings

app = FastAPI(title="Manga Translator API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ocr.router, prefix="/api/ocr", tags=["OCR"])
# app.include_router(settings_api.router, ...) — removed, config is client-side


@app.get("/")
async def root():
    return {"message": "Manga Translator API", "version": "1.0.0"}


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=settings.PORT, reload=True)
