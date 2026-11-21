// 工具定义的唯一来源：Worker（远程 MCP）与 Termux Agent（本地 MCP）共用。
// 只允许依赖 zod，不能引入 Node 内置模块，否则 Worker 打包会失败。
import { z } from "zod";

const EXCLUDE_DIRS = z
  .array(z.string())
  .default(["node_modules", ".git"])
  .describe("要排除的目录名列表，默认 [\"node_modules\", \".git\"]");

export const TOOL_SPECS = [
  {
    name: "run_command",
    description:
      "在 Termux 中执行一条非交互式 shell 命令，返回 stdout / stderr / 退出码。适合单条命令。" +
      "远程调用默认 30 秒、最长 45 秒；更久的任务请用 job_start。",
    schema: {
      command: z.string().describe("要执行的 shell 命令"),
      cwd: z.string().optional().describe("工作目录；相对路径基于 $HOME。默认 $HOME"),
      timeout_ms: z.number().int().min(500).max(45000).default(30000).describe("超时毫秒，默认 30000，最大 45000"),
    },
  },
  {
    name: "read_file",
    description:
      "读取文本文件。相对路径基于 $HOME。远程单次最多返回约 180KB，超出会截断；疑似二进制会拒绝。",
    schema: {
      path: z.string(),
      max_bytes: z.number().int().min(1024).max(10 * 1024 * 1024).optional().describe("最多读取多少字节，默认 2MB（远程仍会按 180KB 截断）"),
    },
  },
  {
    name: "write_file",
    description:
      "写入文本文件（不存在则创建，存在则覆盖），自动创建父目录。远程单次建议不超过 500KB。",
    schema: {
      path: z.string(),
      content: z.string(),
      create_dirs: z.boolean().default(true).describe("自动创建父目录，默认 true"),
    },
  },
  {
    name: "edit_file",
    description:
      "对文本文件做一次精确替换，不用整文件重写。old_text 必须与文件内容逐字一致（含缩进、换行）；" +
      "出现多次时需扩大选区使其唯一，或 replace_all=true。",
    schema: {
      path: z.string(),
      old_text: z.string().describe("要被替换的原文（逐字一致）"),
      new_text: z.string().describe("替换后的新文本"),
      replace_all: z.boolean().default(false).describe("替换全部出现位置，默认 false"),
    },
  },
  {
    name: "list_dir",
    description: "列出目录内容（名称、类型、大小、修改时间）。相对路径基于 $HOME。",
    schema: {
      path: z.string().default(".").describe("目录路径，默认 $HOME"),
    },
  },
  {
    name: "delete",
    description: "删除文件或目录（目录需 recursive=true）。受保护的系统根路径本身不允许删除。",
    schema: {
      path: z.string(),
      recursive: z.boolean().default(false),
    },
  },
  {
    name: "move",
    description: "移动或重命名文件/目录；跨文件系统自动回退为复制+删除。",
    schema: {
      from: z.string(),
      to: z.string(),
    },
  },
  {
    name: "search_files",
    description:
      "按文件名递归搜索（find 包装），支持 glob（*.log、config.*），大小写不敏感。返回绝对路径列表。",
    schema: {
      pattern: z.string().describe("文件名模式，支持 glob，如 *.log、README*"),
      dir: z.string().optional().describe("起始目录，默认 $HOME"),
      type: z.enum(["file", "dir", "any"]).default("any"),
      max_depth: z.number().int().min(1).max(32).default(10),
      max_results: z.number().int().min(1).max(2000).default(200),
      exclude_dirs: EXCLUDE_DIRS,
    },
  },
  {
    name: "grep_files",
    description:
      "按内容递归搜索（grep -rnE），默认跳过 node_modules/.git 和二进制文件。返回 文件:行号:内容。",
    schema: {
      pattern: z.string().describe("要搜索的内容（扩展正则 ERE）"),
      dir: z.string().optional().describe("起始目录，默认 $HOME"),
      include: z.string().optional().describe("只搜文件名匹配该 glob 的文件，如 *.js"),
      ignore_case: z.boolean().default(false),
      context_lines: z.number().int().min(0).max(5).default(0),
      max_results: z.number().int().min(1).max(2000).default(100),
      exclude_dirs: EXCLUDE_DIRS,
    },
  },
  {
    name: "system_info",
    description:
      "返回设备与系统信息：系统/发行版、架构、内核、CPU 型号与核心数、内存、磁盘、Node 版本、Agent 状态。" +
      "Android 上不提供 loadavg（内核不导出），改为读不到的字段直接省略，不要把它当作 0。",
    schema: {},
  },
  {
    name: "shell_open",
    description:
      "打开一个真实交互式 PTY shell（可跑 top/vim；cd 与环境变量跨调用保留）。返回 sessionId。" +
      "适合需要 TTY 的场景；纯命令优先用 run_command。",
    schema: {
      rows: z.number().int().min(1).max(200).default(24),
      cols: z.number().int().min(1).max(400).default(80),
    },
  },
  {
    name: "shell_send",
    description:
      "向 PTY 会话发送输入。submit=true（默认）自动补换行、提交命令并等待完成，返回退出码；" +
      "submit=false 只发原始文本（回答 rm -i / read -p 等提示）；中断用 key=ctrl-c。",
    schema: {
      sessionId: z.string().describe("shell_open 返回的 sessionId"),
      text: z.string().optional().describe("要发送的文本"),
      key: z
        .enum(["ctrl-c", "ctrl-d", "ctrl-z", "enter", "esc", "tab", "backspace", "up", "down", "left", "right"])
        .optional()
        .describe("特殊键"),
      submit: z.boolean().default(true).describe("true=补换行并等待命令完成；false=只发原始文本"),
      wait_ms: z.number().int().min(50).max(30000).default(1500).describe("最长等待毫秒，默认 1500"),
    },
  },
  {
    name: "shell_view",
    description: "查看 PTY 会话当前屏幕内容（不发送输入）。",
    schema: {
      sessionId: z.string(),
      tail: z.number().int().min(100).max(20000).default(4000).describe("返回最后多少字符"),
    },
  },
  {
    name: "shell_close",
    description: "关闭一个 PTY 会话。",
    schema: { sessionId: z.string() },
  },
  {
    name: "shell_list",
    description: "列出所有活跃 PTY 会话（含屏幕预览）；sessionId 忘了时用它找回。",
    schema: {},
  },
  {
    name: "job_start",
    description:
      "在后台启动长时间任务（构建、下载、服务等），立即返回 jobId，不受单次调用超时限制。" +
      "用 job_status 查看增量输出，job_kill 终止。",
    schema: {
      command: z.string().describe("要执行的 shell 命令"),
      cwd: z.string().optional().describe("工作目录，默认 $HOME"),
      name: z.string().optional().describe("任务备注名，便于辨认"),
    },
  },
  {
    name: "job_status",
    description:
      "查看后台任务状态与输出尾部。wait_ms>0 时最多等待该时长（用于轮询长任务）。",
    schema: {
      jobId: z.string(),
      tail_bytes: z.number().int().min(1024).max(200000).default(20000).describe("返回输出尾部多少字节"),
      wait_ms: z.number().int().min(0).max(30000).default(0).describe("最多等待毫秒，默认 0"),
    },
  },
  {
    name: "job_kill",
    description: "终止后台任务（默认 SIGTERM，可发 SIGKILL），会连同其子进程一起结束。",
    schema: {
      jobId: z.string(),
      signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"]).default("SIGTERM"),
    },
  },
  {
    name: "job_list",
    description: "列出当前所有后台任务（运行中与最近结束的）。",
    schema: {},
  },
];

export const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

// 每个工具的 zod 对象，用于把外部传入的 args 解析成带默认值的规范参数
export const TOOL_OBJECTS = Object.fromEntries(
  TOOL_SPECS.map((t) => [t.name, z.object(t.schema)])
);
