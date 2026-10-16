/**
 * 帮助文案：六节结构与三个动作，内容逐字对齐线上（本地化偏差项见差异清单 §F）
 * 追溯：LLD V2.0 §9.1 ｜ SRS V2.0 F-6.7（3.5.6.7）
 * 语言覆盖：zh-CN 全量；其余语言按 SRS 缺项回落规则显示简体中文
 */

export interface HelpSection {
  title: string;
  items: Array<{ label?: string; text: string }>;
}

export const HELP_ZH: HelpSection[] = [
  {
    title: '简介',
    items: [
      {
        text:
          'MarkDesk 是一款轻量、即开即用的本地 Markdown 编辑器——无需安装，打开即用。支持实时编辑与预览，内容自动保存至本机；更简洁美观的编辑与预览界面，支持离线编辑、浅色/深色主题与多语言界面，并可将文档导出为 HTML、Word、PDF、PNG 等格式。',
      },
    ],
  },
  {
    title: '快速开始',
    items: [
      { text: '在编辑区输入 Markdown，预览区同步渲染。' },
      { text: '工具栏可插入标题、格式、列表、引用、代码、链接、图片、表格等。' },
      { text: '选中文字后点格式按钮，可包裹或替换选区。' },
      { text: '预览区可直接改段落、标题、列表与表格文字，改动会写回源码。' },
      { text: '编辑区右下角键盘图标可查看全部快捷键。' },
    ],
  },
  {
    title: '视图与界面',
    items: [
      { text: '拖动中间分隔线，调整编辑区与预览区宽度。' },
      { text: '侧栏「视图」可切换：编辑 + 预览 / 仅编辑 / 仅预览，或进入全屏。' },
      { text: '侧栏底部可切换浅色/深色主题与界面语言。' },
    ],
  },
  {
    title: '保存与文件',
    items: [
      { label: '手动保存', text: 'Ctrl+S 或「保存」。首次另存为，之后覆盖同一文件。' },
      { label: '自动保存', text: '每 500ms 写入本机留存，重启可恢复；自动保存不写入磁盘。' },
      { label: '打开', text: '侧栏「打开」或拖入 .md / .txt 文件。' },
      { label: '导入', text: '顶部「导入」可将 HTML / Word (.docx) 转为可编辑的 Markdown 草稿。' },
      { label: '导出', text: '顶部「导出」可另存 Markdown、HTML、Word、PDF、图片等副本。' },
      { label: '记住目录', text: '打开与保存会记住上次文件夹。' },
      { label: '新建', text: '创建空白文档；若当前文档未保存到磁盘，会先提示保存。' },
      { label: '最近', text: '显示最近打开的 10 个文件。' },
    ],
  },
  {
    title: '清除本地数据',
    items: [
      { text: '「恢复默认欢迎页」：把编辑区内容恢复为初始示例，保留主题与语言等设置。' },
      { text: '「清除全部数据」：清除留存内容、界面设置、文件记录与目录记忆，回到首次使用状态。' },
      { text: '清理只作用于本机留存数据，不会删除你已保存到磁盘的文档与图片资源夹。' },
    ],
  },
  {
    title: '扩展内容',
    items: [
      { text: '「图片」支持链接或本地上传；本地图片保存到磁盘时写入与文档同级的资源夹（如 文档名_assets/），Markdown 中使用相对路径。导出 HTML / Word / PDF / 图片时会烘焙嵌入。' },
      { text: '支持 $…$ 行内公式与 $$…$$ 块级公式（KaTeX）。' },
      { text: '「Mermaid」可插入流程图、思维导图等图表。' },
    ],
  },
];

export const HELP_EN: HelpSection[] = [
  {
    title: 'Overview',
    items: [
      {
        text:
          'MarkDesk is a lightweight, ready-to-use local Markdown editor — no installation, just open and write. It previews while you type and auto-saves to this machine, works fully offline, supports light/dark themes and ten interface languages, and exports to HTML, Word, PDF, PNG and Markdown.',
      },
    ],
  },
  {
    title: 'Quick start',
    items: [
      { text: 'Type Markdown in the editor; the preview renders in sync.' },
      { text: 'The toolbar inserts headings, styles, lists, quotes, code, links, images and tables.' },
      { text: 'Select text, then click a format button to wrap or replace it.' },
      { text: 'Edit paragraphs, headings, lists and table text directly in the preview; changes write back to the source.' },
      { text: 'The keyboard icon at the bottom of the editor lists all shortcuts.' },
    ],
  },
  {
    title: 'View & interface',
    items: [
      { text: 'Drag the divider to resize the editor and preview.' },
      { text: 'Sidebar View switches between Editor + Preview / Editor only / Preview only, or enters full screen.' },
      { text: 'The bottom of the sidebar switches theme and interface language.' },
    ],
  },
  {
    title: 'Save & files',
    items: [
      { label: 'Manual save', text: 'Ctrl+S or Save. The first save asks for a location; later saves overwrite the same file.' },
      { label: 'Auto save', text: 'Every 500ms the content is kept locally and restored on restart; auto save never writes to disk.' },
      { label: 'Open', text: 'Sidebar Open, or drop a .md / .txt file.' },
      { label: 'Import', text: 'Top bar Import converts HTML / Word (.docx) into an editable Markdown draft.' },
      { label: 'Export', text: 'Top bar Export creates Markdown, HTML, Word, PDF or image copies.' },
      { label: 'Remembered folders', text: 'Open and save reuse the last folder.' },
      { label: 'New', text: 'Creates a blank document; unsaved content is confirmed first.' },
      { label: 'Recent', text: 'Shows the last 10 files you opened.' },
    ],
  },
  {
    title: 'Clear local data',
    items: [
      { text: 'Restore default welcome page: resets the editor to the sample content, keeping theme and language.' },
      { text: 'Clear all data: removes kept content, settings, file records and remembered folders, back to first run.' },
      { text: 'Cleaning only touches local data. Documents and image folders you saved to disk are never deleted.' },
    ],
  },
  {
    title: 'Extras',
    items: [
      { text: 'Images can come from a link or a local upload; local images are written to a folder next to the document (name_assets/) and referenced by relative path. They are baked into HTML / Word / PDF / image exports.' },
      { text: 'Inline $…$ and block $$…$$ formulas (KaTeX) are supported.' },
      { text: 'Mermaid inserts flow charts, mind maps and other diagrams.' },
    ],
  },
];
