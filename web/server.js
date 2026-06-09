'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const WAIFU2X_BIN = process.env.WAIFU2X_BIN || path.resolve(__dirname, '../waifu2x-ncnn-vulkan');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const MODELS_DIR = path.resolve(__dirname, '../models');

// Ensure directories exist
[UPLOADS_DIR, OUTPUTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/outputs', express.static(OUTPUTS_DIR));

// In-memory task store: taskId -> { status, inputFile, outputFile, logs, proc }
const tasks = new Map();

// SSE connections: taskId -> [res, ...]
const sseClients = new Map();

// File upload
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// POST /api/upload
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Invalid or missing image file' });
  const taskId = uuidv4();
  tasks.set(taskId, {
    status: 'uploaded',
    inputFile: req.file.filename,
    outputFile: null,
    logs: [],
  });
  res.json({ taskId, inputUrl: `/uploads/${req.file.filename}` });
});

// POST /api/process
app.post('/api/process', (req, res) => {
  const { taskId, noise = 0, scale = 2, model = 'models-cunet', gpuid = -1, format = 'png', tta = false } = req.body;

  const task = tasks.get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status === 'processing') return res.status(409).json({ error: 'Already processing' });

  // Validate params
  if (![-1, 0, 1, 2, 3].includes(Number(noise))) return res.status(400).json({ error: 'Invalid noise' });
  if (![1, 2, 4, 8, 16, 32].includes(Number(scale))) return res.status(400).json({ error: 'Invalid scale' });
  const allowedModels = ['models-cunet', 'models-upconv_7_anime_style_art_rgb', 'models-upconv_7_photo'];
  if (!allowedModels.includes(model)) return res.status(400).json({ error: 'Invalid model' });
  if (!['png', 'jpg', 'webp'].includes(format)) return res.status(400).json({ error: 'Invalid format' });

  const inputPath = path.join(UPLOADS_DIR, task.inputFile);
  const outputFilename = `${taskId}_out.${format}`;
  const outputPath = path.join(OUTPUTS_DIR, outputFilename);
  const modelPath = path.join(MODELS_DIR, model);

  const args = [
    '-i', inputPath,
    '-o', outputPath,
    '-n', String(noise),
    '-s', String(scale),
    '-m', modelPath,
    '-g', String(gpuid),
    '-f', format,
  ];
  if (tta) args.push('-x');

  task.status = 'processing';
  task.outputFile = outputFilename;
  task.logs = [`[INFO] Starting waifu2x: ${path.basename(WAIFU2X_BIN)} ${args.join(' ')}`];

  const proc = spawn(WAIFU2X_BIN, args);
  task.proc = proc;

  const pushLog = (line) => {
    task.logs.push(line);
    const clients = sseClients.get(taskId) || [];
    clients.forEach(client => {
      try { client.write(`data: ${JSON.stringify({ log: line })}\n\n`); } catch (_) {}
    });
  };

  const pushEvent = (event, data) => {
    const clients = sseClients.get(taskId) || [];
    clients.forEach(client => {
      try {
        client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (event === 'done' || event === 'error') client.end();
      } catch (_) {}
    });
    sseClients.delete(taskId);
  };

  proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(pushLog));
  proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(pushLog));

  proc.on('close', (code) => {
    if (code === 0) {
      task.status = 'done';
      pushEvent('done', { outputUrl: `/outputs/${outputFilename}` });
    } else {
      task.status = 'error';
      pushEvent('error', { message: `Process exited with code ${code}` });
    }

    // Auto-cleanup after 30 minutes
    setTimeout(() => {
      try { fs.unlinkSync(inputPath); } catch (_) {}
      try { fs.unlinkSync(outputPath); } catch (_) {}
      tasks.delete(taskId);
    }, 30 * 60 * 1000);
  });

  proc.on('error', (err) => {
    task.status = 'error';
    pushLog(`[ERROR] Failed to start process: ${err.message}`);
    pushEvent('error', { message: err.message });
  });

  res.json({ ok: true });
});

// GET /api/progress/:taskId  (SSE)
app.get('/api/progress/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = tasks.get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send buffered logs
  task.logs.forEach(line => res.write(`data: ${JSON.stringify({ log: line })}\n\n`));

  if (task.status === 'done') {
    res.write(`event: done\ndata: ${JSON.stringify({ outputUrl: `/outputs/${task.outputFile}` })}\n\n`);
    return res.end();
  }
  if (task.status === 'error') {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Processing failed' })}\n\n`);
    return res.end();
  }

  if (!sseClients.has(taskId)) sseClients.set(taskId, []);
  sseClients.get(taskId).push(res);

  req.on('close', () => {
    const clients = sseClients.get(taskId) || [];
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
});

// GET /api/result/:taskId
app.get('/api/result/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task || task.status !== 'done') return res.status(404).json({ error: 'Result not ready' });
  res.download(path.join(OUTPUTS_DIR, task.outputFile));
});

// GET /api/gpus  - list available GPUs
app.get('/api/gpus', (req, res) => {
  const proc = spawn(WAIFU2X_BIN, ['-i', '/dev/null', '-o', '/dev/null']);
  let output = '';
  proc.stderr.on('data', d => (output += d.toString()));
  proc.on('close', () => {
    // Parse GPU lines like "[0 NVIDIA GeForce RTX 3080]"
    const gpus = [];
    const re = /\[(\d+)\s+(.+?)\]/g;
    let m;
    while ((m = re.exec(output)) !== null) gpus.push({ id: Number(m[1]), name: m[2] });
    res.json({ gpus });
  });
  proc.on('error', () => res.json({ gpus: [] }));
});

app.listen(PORT, () => {
  console.log(`waifu2x Web UI running at http://localhost:${PORT}`);
  console.log(`waifu2x binary: ${WAIFU2X_BIN}`);
});
