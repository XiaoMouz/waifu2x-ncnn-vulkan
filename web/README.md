# waifu2x Web UI

基于 Node.js + Express 的网页前端，用于调用本地 `waifu2x-ncnn-vulkan` 二进制进行图像超分辨率增强。

## 依赖

- Node.js 16+
- 已编译的 `waifu2x-ncnn-vulkan` 可执行文件（位于上级目录）

## 启动

```bash
cd web
npm install
npm start
```

浏览器打开 http://localhost:3000

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务监听端口 |
| `WAIFU2X_BIN` | `../waifu2x-ncnn-vulkan` | waifu2x 二进制路径 |

## 功能

- 拖拽或点击上传图片（JPG / PNG / WebP，最大 10MB）
- 配置噪点去除等级、放大倍数、模型、计算设备（GPU/CPU）、输出格式、TTA 模式
- 实时查看处理日志（SSE 推送）
- 处理完成后并排对比原图与增强图
- 一键下载结果图片
- 临时文件 30 分钟后自动清理
