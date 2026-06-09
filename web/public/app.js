'use strict';

// --- State ---
let taskId = null;
let inputUrl = null;

// --- DOM refs ---
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const previewWrap = document.getElementById('preview-wrap');
const previewImg = document.getElementById('preview-img');
const previewInfo = document.getElementById('preview-info');
const processBtn = document.getElementById('process-btn');
const progressSection = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const logBox = document.getElementById('log-box');
const resultSection = document.getElementById('result-section');
const resultBefore = document.getElementById('result-before');
const resultAfter = document.getElementById('result-after');
const downloadBtn = document.getElementById('download-btn');
const resetBtn = document.getElementById('reset-btn');
const gpuSelect = document.getElementById('gpu-select');
const ttaToggle = document.getElementById('tta-toggle');

// --- Button group helpers ---
function getGroupValue(groupId) {
  const active = document.querySelector(`#${groupId} .btn-opt.active`);
  return active ? active.dataset.val : null;
}

document.querySelectorAll('.btn-group').forEach(group => {
  group.addEventListener('click', e => {
    const btn = e.target.closest('.btn-opt');
    if (!btn) return;
    group.querySelectorAll('.btn-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// --- Load GPU list ---
fetch('/api/gpus')
  .then(r => r.json())
  .then(({ gpus }) => {
    gpus.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `GPU ${g.id}: ${g.name}`;
      gpuSelect.appendChild(opt);
    });
  })
  .catch(() => {});

// --- Drag & drop upload ---
dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  if (!file.type.startsWith('image/')) return alert('请选择图片文件（JPG / PNG / WebP）');
  if (file.size > 10 * 1024 * 1024) return alert('文件大小不能超过 10MB');

  const reader = new FileReader();
  reader.onload = e => {
    previewImg.src = e.target.result;
    previewWrap.classList.remove('hidden');
  };
  reader.readAsDataURL(file);

  const sizeMB = (file.size / 1024 / 1024).toFixed(2);
  previewInfo.textContent = `${file.name}  ·  ${sizeMB} MB`;

  // Upload to server
  const formData = new FormData();
  formData.append('image', file);
  processBtn.disabled = true;
  processBtn.textContent = '上传中…';

  fetch('/api/upload', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      taskId = data.taskId;
      inputUrl = data.inputUrl;
      processBtn.disabled = false;
      processBtn.textContent = '开始处理';
    })
    .catch(err => {
      alert(`上传失败: ${err.message}`);
      processBtn.textContent = '开始处理';
    });
}

// --- Process ---
processBtn.addEventListener('click', () => {
  if (!taskId) return;

  const params = {
    taskId,
    noise: getGroupValue('noise-group'),
    scale: getGroupValue('scale-group'),
    model: document.getElementById('model-select').value,
    gpuid: gpuSelect.value,
    format: getGroupValue('format-group'),
    tta: ttaToggle.checked,
  };

  processBtn.disabled = true;
  progressSection.classList.remove('hidden');
  resultSection.classList.add('hidden');
  logBox.innerHTML = '';
  progressBar.style.width = '0%';
  progressBar.classList.add('indeterminate');

  fetch('/api/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      listenProgress(taskId);
    })
    .catch(err => {
      appendLog(`[ERROR] ${err.message}`, 'error');
      progressBar.classList.remove('indeterminate');
      processBtn.disabled = false;
    });
});

function listenProgress(id) {
  const es = new EventSource(`/api/progress/${id}`);

  es.addEventListener('message', e => {
    const { log } = JSON.parse(e.data);
    appendLog(log);
  });

  es.addEventListener('done', e => {
    es.close();
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = '100%';
    const { outputUrl } = JSON.parse(e.data);
    showResult(outputUrl);
  });

  es.addEventListener('error', e => {
    es.close();
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = '0%';
    let msg = '处理失败';
    try { msg = JSON.parse(e.data).message; } catch (_) {}
    appendLog(`[ERROR] ${msg}`, 'error');
    processBtn.disabled = false;
  });

  // Handle SSE connection error (e.g., server down)
  es.onerror = () => {
    const task = tasks && tasks.get ? null : null; // client-side only
    // If readyState is CLOSED, the server ended the stream (normal after done/error)
    if (es.readyState === EventSource.CLOSED) return;
    appendLog('[WARN] 连接中断，请检查服务器状态', 'error');
    es.close();
    processBtn.disabled = false;
  };
}

function appendLog(line, type = '') {
  const div = document.createElement('div');
  div.textContent = line;
  if (type === 'error') div.classList.add('log-error');
  if (type === 'success') div.classList.add('log-success');
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

function showResult(outputUrl) {
  resultBefore.src = inputUrl;
  resultAfter.src = outputUrl + '?t=' + Date.now();
  downloadBtn.href = outputUrl;
  const ext = outputUrl.split('.').pop();
  downloadBtn.download = `waifu2x_result.${ext}`;
  resultSection.classList.remove('hidden');
  appendLog('[INFO] 处理完成！', 'success');
  processBtn.textContent = '重新处理';
  processBtn.disabled = false;
  resultSection.scrollIntoView({ behavior: 'smooth' });
}

// --- Reset ---
resetBtn.addEventListener('click', () => {
  taskId = null;
  inputUrl = null;
  previewWrap.classList.add('hidden');
  previewImg.src = '';
  progressSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  logBox.innerHTML = '';
  processBtn.disabled = true;
  processBtn.textContent = '开始处理';
  fileInput.value = '';
  progressBar.style.width = '0%';
  progressBar.classList.remove('indeterminate');
});
