# MangaTrans

漫画翻译工作台。上传本地图片，自动 OCR 识别文字、LLM 批量翻译、智能消除原文、将译文回填至图片。

**纯前端应用，无需任何后端服务。**

## 功能

- **OCR 识别**：调用 PaddleOCR 官方云端 API（PP-OCRv5），自动合并相邻对话框
- **LLM 批量翻译**：OpenAI 兼容接口，直接从前端调用，支持 OpenAI、DeepSeek、通义千问等
- **文字消除**：前端 Web Worker + OpenCV.js，多边形掩码精确还原背景
- **文字替换**：二分查找自适应字体大小，译文完整填入原文区域
- **一键流程**：OCR → 翻译 → 消除 → 替换，一次点击完成
- **批量处理**：支持整个文件夹批量加载，页码导航
- **数据缓存**：OCR 结果和译文持久化到 localStorage（24h），消除图片存入 sessionStorage

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React · TypeScript · Vite · Tailwind CSS v4 |
| OCR | PaddleOCR 官方云端 API（PP-OCRv5），前端直调 |
| 翻译 | OpenAI 兼容 LLM，前端直调 |
| 文字消除 | Web Worker + OpenCV.js（WASM） |
| 存储 | localStorage（配置/OCR/译文）· sessionStorage（消除图）· 内存（原图） |

## 快速开始

```bash
cd app
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
| API Token | 从 [AI Studio](https://aistudio.baidu.com) 获取 |
| 模型 | 默认 `PP-OCRv5` |

## 项目结构

```
manga-trans/
└── app/
    └── src/
        ├── components/
        │   ├── Workbench.tsx          # 主翻译工作台
        │   └── SettingsPanel.tsx      # LLM / OCR 配置页
        ├── services/
        │   ├── llmConfig.ts           # LLM 配置（localStorage）
        │   ├── ocrConfig.ts           # OCR 配置（localStorage）
        │   ├── ocrService.ts          # OCR 云端直调 + 对话框合并
        │   ├── translationService.ts  # LLM 翻译（前端直调）
        │   └── inpaintService.ts      # 文字消除（Web Worker + OpenCV.js）
        └── store/
            ├── workbenchContext.tsx   # 全局状态
            └── storage.ts             # 持久化工具
```
