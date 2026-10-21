import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const marker = 'metadata-only; interface existence is not verified operation coverage';
const integer = (value, fallback, max) => value === undefined ? fallback : Number.isInteger(value) && value >= 0 && value <= max ? value : (() => { throw new Error('分页参数无效。'); })();
const page = (rows, args) => {
  const offset = integer(args.offset, 0, 100000), limit = integer(args.limit, 12, 50);
  return { total: rows.length, offset, items: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null };
};
export function createSolidworksCatalog(root) {
  const cache = new Map();
  const json = async file => {
    if (!cache.has(file)) cache.set(file, readFile(join(root, file), 'utf8').then(JSON.parse).catch(error => { cache.delete(file); throw error; }));
    return cache.get(file);
  };
  return async args => {
    if (!args || typeof args.operation !== 'string') throw new Error('请选择 SolidWorks 查询操作。');
    if (args.operation === 'guide') return { text: await readFile(join(root, 'GUIDE.md'), 'utf8') };
    if (args.operation === 'evidence') {
      const index = await json('evidence/index.json');
      if (args.id) {
        const entry = index.reports.find(row => row.id === args.id);
        if (!entry) throw new Error('未找到测试记录。');
        return { ...entry, report: await json(`evidence/${entry.file}`) };
      }
      return { ...Object.fromEntries(Object.entries(index).filter(([key]) => key !== 'reports')), ...page(index.reports.filter(row => !args.query || row.id.toLowerCase().includes(args.query.toLowerCase())), args) };
    }
    if (args.operation === 'recipe') {
      const recipes = await json('recipes/index.json');
      if (!args.id) return page(recipes.recipes.filter(row => !args.query || JSON.stringify(row).toLowerCase().includes(args.query.toLowerCase())), args);
      const recipe = recipes.recipes.find(row => row.id === args.id);
      if (!recipe) throw new Error('未找到方法参考。');
      const source = await readFile(join(root, 'recipes', recipe.file), 'utf8');
      const lines = source.split(/\r?\n/u), offset = integer(args.offset, 0, 100000), limit = integer(args.limit, 50, 200);
      return { ...recipe, notice: '历史验收脚本只作方法参考。不要执行旧脚本/Run构造器；改写为当前cad/sw对象并在当前工作文件夹核对结果。', totalLines: lines.length, offset, source: lines.slice(offset, offset + limit).join('\n'), nextOffset: offset + limit < lines.length ? offset + limit : null };
    }
    const index = await json('catalog/index.json');
    if (args.operation === 'libraries') return { ...index, status: marker };
    if (!['search', 'member', 'enum', 'type'].includes(args.operation)) throw new Error('无效的 SolidWorks 查询操作。');
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 160) throw new Error('请输入不超过160字的接口、方法或枚举关键词。');
    const query = args.query.toLowerCase();
    const libraries = args.library ? index.libraries.filter(row => row.file.replace(/\.json$/u, '') === args.library || row.name === args.library) : index.libraries;
    if (!libraries.length) throw new Error('未找到类型库。');
    const results = [];
    for (const library of libraries) {
      const data = await json(`catalog/${library.file}`);
      for (const type of data.types) {
        if (args.type && args.type !== type.name) continue;
        if (args.operation === 'type') {
          if (type.name.toLowerCase().includes(query)) results.push({ library: library.name, name: type.name, guid: type.guid, kind: type.kind,
            memberCount: type.members?.length ?? 0, constantCount: type.constants?.length ?? 0,
            memberExamples: type.members?.slice(0, 12).map(row => row.name), notice: 'Use search/enum with this type and pagination for the complete list.' });
          continue;
        }
        const rows = args.operation === 'enum' ? type.constants ?? [] : type.members ?? [];
        for (const row of rows) if ((args.operation === 'member' ? row.name.toLowerCase() === query : `${type.name} ${row.name} ${row.description ?? ''}`.toLowerCase().includes(query))) {
          results.push({ library: library.name, type: type.name, ...row });
        }
      }
    }
    return { status: marker, target: index.target, ...page(results, args) };
  };
}
