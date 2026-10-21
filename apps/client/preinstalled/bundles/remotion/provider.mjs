import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const remotionSkillName = 'remotion-motion-graphics';
export const remotionDescription = '制作或编辑视频、动画、片头片尾、宣传片、短视频、字幕或现有Remotion项目时，先加载本技能；包含动效设计、制作、渲染和逐帧视觉验收流程。';

export function createRemotionProvider({ runtimeRoot, rank, node = process.execPath }) {
  if (!isAbsolute(runtimeRoot)) throw new Error('Remotion运行目录必须是固定绝对路径。');
  const runtime = join(resolve(runtimeRoot), 'company-tools/remotion');
  const directory = join(runtime, remotionSkillName), file = join(directory, 'SKILL.md');
  const candidate = { name: remotionSkillName, description: remotionDescription,
    invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 'rufa-remotion', rank,
    path: file, resourceBase: { kind: 'directory', path: directory.split(sep).join('/') }, locator: file };
  return {
    name: 'rufa-remotion',
    async list(options = {}) { options.signal?.throwIfAborted(); await access(file); options.signal?.throwIfAborted(); return [candidate]; },
    async get(requested, options = {}) {
      if (requested.name !== remotionSkillName || requested.locator !== file) throw new Error('无效的Remotion技能资源。');
      const raw = await readFile(file, { encoding: 'utf8', signal: options.signal });
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
      if (!frontmatter || !/^name:\s*remotion-motion-graphics\s*$/mu.test(frontmatter[1])) throw new Error('预装Remotion技能格式不匹配。');
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      const environment = { node, runner: join(runtime, 'runner.mjs'), runtime, resources: directory,
        electronRunAsNode: !!process.versions.electron,
        commands: {
          init: ['init', '<新空目录>'], compositions: ['compositions', '<src/index.ts>'],
          render: ['render', '<src/index.ts>', '<CompositionId>', '<output.mp4>', '--codec', 'h264', '--crf', '17'],
          still: ['still', '<src/index.ts>', '<CompositionId>', '<check.png>', '--frame', '15'],
          probe: ['probe', '<媒体文件>'], frame: ['frame', '<媒体文件>', '<check.png>', '--time', '1.5'],
        } };
      return { ...summary, content: raw.slice(frontmatter[0].length).trim() + '\n\n## Rufajx-DSH 本机运行环境\n\n'
        + '本机已有固定版本的Remotion依赖与浏览器。使用下列node运行runner，再分别传入命令数组中的参数；中文和空格路径须各自引用，不拼成一条未转义字符串。若electronRunAsNode为true，仅为该子进程设置ELECTRON_RUN_AS_NODE=1。在当前任务工作目录创建项目与输出，不修改共享运行目录。init只接受新空目录，生成入口、theme和public；你还需编写Root和scenes，无需npm安装或项目node_modules。已有输出须明确加--overwrite才能覆盖；render可附--props参数。浏览器由runner固定提供，官方CLI仍可用于高级参数。正文中的npm安装、npx下载和系统浏览器查找是通用示例，此部署使用预装入口。遵守原生逐工具审查；完成后实际渲染并查看关键帧再交付。\n\n'
        + JSON.stringify(environment, null, 2) };
    },
  };
}
