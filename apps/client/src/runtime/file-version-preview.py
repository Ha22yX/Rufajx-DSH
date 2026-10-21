"""Read-only, bounded Office/text comparison; original version bytes stay intact."""
import argparse
import difflib
import json
import os
import posixpath
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_BYTES = 32 * 1024 * 1024
MAX_TEXT = 2 * 1024 * 1024
MAX_ENTRIES = 5000
MAX_ITEMS = 30000
MAX_CHANGES = 200
MAX_VALUE = 2000
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


class PreviewUnavailable(Exception):
    pass


class Office:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path)
        files = self.zip.infolist()
        if len(files) > MAX_ENTRIES or sum(f.file_size for f in files) > MAX_BYTES:
            self.zip.close()
            raise PreviewUnavailable('文件内容较多，暂不展开内容对比。')
        if len({f.filename for f in files}) != len(files):
            self.zip.close()
            raise PreviewUnavailable('文件结构无法可靠比较。')

    def xml(self, path):
        try:
            data = self.zip.read(path)
        except KeyError:
            raise PreviewUnavailable('文件缺少可读取的内容。')
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            raise PreviewUnavailable('文件结构无法可靠比较。')
        return ET.fromstring(data)

    def relations(self, path, base):
        result = {}
        for item in self.xml(path):
            if item.get('TargetMode') == 'External':
                continue
            target = item.get('Target', '')
            if '\\' in target:
                raise PreviewUnavailable('文件内部引用无法可靠比较。')
            joined = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(base, target))
            if joined.startswith('../') or ':' in joined:
                raise PreviewUnavailable('文件内部引用无法可靠比较。')
            result[item.get('Id')] = joined
        return result


def text_of(element, namespace):
    return ''.join(node.text or '' for node in element.iter(namespace + 't'))


def read_docx(doc):
    root = doc.xml('word/document.xml')
    # Tables also contain paragraphs; include their text in document order.
    rows = [text_of(p, W) for p in root.iter(W + 'p')]
    if len(rows) > MAX_ITEMS:
        raise PreviewUnavailable('文档段落较多，暂不展开内容对比。')
    return rows


def read_xlsx(doc):
    shared = []
    if 'xl/sharedStrings.xml' in doc.zip.namelist():
        shared = [text_of(item, S) for item in doc.xml('xl/sharedStrings.xml')]
    links = doc.relations('xl/_rels/workbook.xml.rels', 'xl')
    result = {}
    for sheet in doc.xml('xl/workbook.xml').iter(S + 'sheet'):
        name = sheet.get('name', '未命名工作表')
        path = links.get(sheet.get(R + 'id'))
        if not path:
            raise PreviewUnavailable('工作表引用无法可靠比较。')
        result['工作表「' + name + '」'] = '存在'
        for cell in doc.xml(path).iter(S + 'c'):
            location = '工作表「' + name + '」· ' + cell.get('r', '?')
            value = cell.findtext(S + 'v', '')
            formula = cell.find(S + 'f')
            kind = cell.get('t')
            if kind == 's':
                index = int(value)
                if not 0 <= index < len(shared):
                    raise PreviewUnavailable('单元格引用无法可靠比较。')
                value = shared[index]
            elif kind == 'inlineStr':
                value = text_of(cell, S)
            elif kind == 'b':
                value = '是' if value == '1' else '否'
            if formula is not None:
                description = '共享公式' if formula.get('t') == 'shared' else '数组公式' if formula.get('t') == 'array' else '公式'
                expression = '=' + formula.text if formula.text else description
                value = expression + ('（范围：' + formula.get('ref') + '）' if formula.get('ref') else '') + ('\n计算结果：' + value if value else '')
            # Formatting-only blank cells are outside this content comparison.
            if value != '':
                result[location] = value
            if len(result) > MAX_ITEMS:
                raise PreviewUnavailable('表格单元格较多，暂不展开内容对比。')
    return result


def read_pptx(doc):
    links = doc.relations('ppt/_rels/presentation.xml.rels', 'ppt')
    result = {}
    for index, slide in enumerate(doc.xml('ppt/presentation.xml').iter(P + 'sldId'), 1):
        path = links.get(slide.get(R + 'id'))
        if not path:
            raise PreviewUnavailable('幻灯片引用无法可靠比较。')
        paragraphs = [text_of(p, A) for p in doc.xml(path).iter(A + 'p')]
        result['第 ' + str(index) + ' 页'] = '\n'.join(paragraphs)
    if len(result) > MAX_ITEMS:
        raise PreviewUnavailable('幻灯片较多，暂不展开内容对比。')
    return result


def read_side(path, ext):
    if not path:
        return [] if ext not in ('.xlsx', '.pptx') else {}
    if ext in ('.docx', '.xlsx', '.pptx'):
        doc = Office(path)
        try:
            return {'.docx': read_docx, '.xlsx': read_xlsx, '.pptx': read_pptx}[ext](doc)
        finally:
            doc.zip.close()
    with open(path, 'rb') as file:
        data = file.read(MAX_TEXT + 1)
    if len(data) > MAX_TEXT:
        raise PreviewUnavailable('文件文字较多，暂不展开内容对比。')
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        text = data.decode('utf-16')
    else:
        text = data.decode('utf-8-sig')
    if '\0' in text:
        raise PreviewUnavailable('此文件暂不支持内容对比。')
    lines = text.splitlines()
    if len(lines) > MAX_ITEMS:
        raise PreviewUnavailable('文件行数较多，暂不展开内容对比。')
    return lines


def compare(before, after, ext):
    changes = []
    clipped = False
    count = 0

    def add(location, left, right):
        nonlocal clipped, count
        count += 1
        if len(changes) >= MAX_CHANGES:
            clipped = True
            return
        if len(left) > MAX_VALUE or len(right) > MAX_VALUE:
            clipped = True
        def clip(value):
            return value if len(value) <= MAX_VALUE else value[:MAX_VALUE] + '\n…（内容较长，仅展示部分）'
        changes.append({'location': location, 'before': clip(left), 'after': clip(right)})

    if isinstance(before, dict):
        for key in dict.fromkeys([*before, *after]):
            if before.get(key) != after.get(key):
                add(key, before.get(key, ''), after.get(key, ''))
    else:
        # autojunk bounds work for repetitive long documents. This projection is
        # for display only, never used to reconstruct or restore original files.
        for tag, i, j, k, l in difflib.SequenceMatcher(None, before, after).get_opcodes():
            if tag == 'equal':
                continue
            unit = '段' if ext == '.docx' else '行'
            def span(start, end):
                return '无' if start == end else '第 ' + str(start + 1) + ('–' + str(end) if end > start + 1 else '') + ' ' + unit
            add('原文件：' + span(i, j) + '；新文件：' + span(k, l), '\n'.join(before[i:j]), '\n'.join(after[k:l]))
    return changes, clipped, count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--before', default='')
    parser.add_argument('--after', default='')
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    ext = os.path.splitext(args.name)[1].lower()
    office = ext in ('.docx', '.xlsx', '.pptx')
    try:
        before, after = read_side(args.before, ext), read_side(args.after, ext)
        changes, truncated, count = compare(before, after, ext)
        summary = '发现 ' + str(count) + ' 处内容变化' if count else '可提取的内容没有变化'
        notice = '这里只比较文字和单元格内容；图片、版式、样式等变化未全部列出。恢复会使用完整原文件。' if office else '仅展示文字内容差异；编码或换行方式的变化可能不显示。恢复会使用完整原文件。'
        result = {'kind': 'office' if office else 'text', 'summary': summary, 'notice': notice, 'changes': changes, 'truncated': truncated}
    except (PreviewUnavailable, zipfile.BadZipFile, ET.ParseError, UnicodeError, ValueError, KeyError, OSError):
        result = {'kind': 'binary', 'summary': '文件内容已变化', 'notice': '此文件暂不支持内容对比，仍可恢复已保存的完整版本。', 'changes': [], 'truncated': False}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
