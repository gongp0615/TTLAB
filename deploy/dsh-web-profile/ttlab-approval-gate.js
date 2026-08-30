// TTLAB approval gate (dsh plugin)
//
// Routes high-risk TTLAB MCP tool calls through the dsh approval service so
// the operator confirms them from the TTLAB chat panel. The gate intercepts
// BEFORE the tool reaches the TTLAB MCP server, so an approved call executes
// exactly once (no APPROVAL_REQUIRED retry loop on the MCP side).
export const name = 'ttlab-approval-gate';

const HIGH_RISK_OPERATIONS = new Set(['system.reset', 'device.reboot', 'firmware.flash']);

function parseArgs(raw) {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

export async function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'mcp__ttlab__command_execute') {
      const operation = parseArgs(exec.arguments).operation;
      if (HIGH_RISK_OPERATIONS.has(operation)) {
        return { kind: 'ask', reason: `高风险操作 ${operation} 需要操作员批准` };
      }
    }
    if (exec.name === 'mcp__ttlab__client_update') {
      return { kind: 'ask', reason: '客户端升级需要操作员批准' };
    }
    return next();
  }, { prepend: true });
}
