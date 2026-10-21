// Presentation data only. Never include raw tool arguments, screenshots or input text.
export const toolSteps = Object.freeze({
  health: '检查电脑连接', tools: '检查可用操作', list_windows: '查看已打开的窗口',
  screenshot: '查看当前画面', snapshot: '查看窗口和控件', accessibility_tree: '查看界面结构',
  find: '查找界面控件', element_info: '查看控件信息', activate_window: '切换到目标窗口',
  launch: '打开应用', launch_app: '打开应用', click: '点击界面控件', double_click: '双击界面控件',
  invoke: '操作界面控件', focus: '定位输入位置', type_text: '输入内容', set_value: '填写内容',
  keypress: '执行键盘操作', scroll: '滚动页面', drag: '拖动界面元素', move: '移动指针',
  move_window: '调整窗口位置', close_window: '关闭目标窗口', ocr: '读取画面文字', wait: '等待界面响应', wait_for: '等待界面就绪',
});
export function stepForTool(name) {
  return toolSteps[String(name).replace(/^mcp__wincu__windows_computer_use_/, '')] ?? '执行电脑操作';
}
export function safeProgressText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,})/gi, '…')
    .replace(/((?:password|passwd|api[_ -]?key|token|密码|密钥)\s*[:=：]\s*)\S+/gi, '$1…')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function normalizeProgress(value) {
  if (!value || typeof value !== 'object') return null;
  const task = safeProgressText(value.task, 80);
  const currentStep = safeProgressText(value.currentStep, 100);
  if (!task && !currentStep) return null;
  const completedSteps = (Array.isArray(value.completedSteps) ? value.completedSteps : [])
    .map(text => safeProgressText(text, 80)).filter(Boolean).slice(-3);
  return {
    task: task || '电脑操作',
    currentStep: currentStep || '正在处理任务',
    description: safeProgressText(value.description, 120),
    completedSteps,
    completedCount: Number.isSafeInteger(value.completedCount) && value.completedCount >= 0
      ? Math.min(value.completedCount, 9999) : completedSteps.length,
    status: ['working', 'waiting', 'completed', 'stopped', 'failed'].includes(value.status) ? value.status : 'working',
  };
}
