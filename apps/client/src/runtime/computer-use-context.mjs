/** Reflect the assembled tool surface; the dedicated service enforces execution ownership. */
export function computerUseContext(schemas = []) {
  if (schemas.some(tool => tool.name === 'company_computer_task')) return [{ name: 'company:computer-use', order: 141, interpolate: false,
    text: '用户要求操作本机Windows界面时，通过 company_computer_task 委派独立电脑子智能体。把明确任务和必要上下文交给它；截图、控件和操作细节保留在子会话，主会话只接收最后结果。有任务进行中时不要重复委派，不要读取子任务截图来扩充主会话。用户按Esc或停止后等待新的用户消息，不得换用脚本、命令或其他子任务绕过。后台提示显示真实工具活动，不代表业务目标已核实。' }];
  if (!schemas.some(tool => tool.name.startsWith('mcp__wincu__windows_computer_use_'))) return [];
  return [{ name: 'company:computer-use', order: 141, interpolate: false,
    text: '用户要求操作本机Windows应用、点击界面、填写表单或查看桌面时，使用当前已启用的Windows电脑操作工具。先观察窗口、控件或截图，再执行并核对实际结果；不能把输入已发送当作任务成功。Esc可停止当前操作。所有调用仍遵守当前用户任务范围和原生逐工具审查。' }];
}
