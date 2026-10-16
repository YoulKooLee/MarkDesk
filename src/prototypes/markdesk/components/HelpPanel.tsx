/**
 * 帮助说明：六节内容逐字对齐线上 + 三个动作（恢复默认欢迎页 / 清除全部数据 / 知道了）
 * 追溯：LLD V2.0 §9.1、§十一 ｜ SRS V2.0 F-6.7（3.5.6.7）
 */
import React from 'react';
import { X } from 'lucide-react';
import { HELP_EN, HELP_ZH } from '../lib/helpContent';
import type { LangCode, UiKey } from '../lib/lang';

export interface HelpPanelProps {
  lang: LangCode;
  t: (key: UiKey) => string;
  onRestoreWelcome: () => void;
  onClearAll: () => void;
  onClose: () => void;
}

/**
 * 语法清单：逐条对照 lib/markdown.ts 的实际实现（不多写不支持的写法）。
 * 旧版把多种标记挤在同一行、只列 12 条，读起来吃力且明显不全 ——
 * 现按「块级结构 / 行内标记」分组，一条语法一行。
 */
const SYNTAX_BLOCK: Array<[string, string]> = [
  ['# 标题', '一级到六级标题（# ~ ######），行尾可加 # 收尾'],
  ['- 无序列表', '也可用 * 或 + 起行；缩进两个空格成子级'],
  ['1. 有序列表', '数字加点，可嵌套'],
  ['- [ ] 待办', '预览区点击方框切换完成状态（- [x] 为已完成）'],
  ['> 引用', '可嵌套；引用内还能放列表、代码块、公式'],
  ['| 表头 |', '表格；第二行用 --- 分隔，:--- / ---: 控制对齐'],
  ['---', '分隔线，也可写 *** 或 ___'],
  ['``` 代码块', '围栏代码块，标注语言后按语言着色'],
  ['```mermaid', '标注 mermaid 则渲染流程图 / 思维导图'],
  ['$$ … $$', '块级公式（KaTeX），支持跨行书写'],
];

const SYNTAX_INLINE: Array<[string, string]> = [
  ['**粗体**', '也可写 __粗体__'],
  ['*斜体*', '也可写 _斜体_'],
  ['***粗斜体***', '加粗与倾斜同时生效'],
  ['~~删除线~~', '删除线'],
  ['<u>下划线</u>', '下划线（白名单标签；其余 HTML 按原文呈现，不会被解析）'],
  ['==高亮==', '高亮标记'],
  ['^上标^', '上标，标记内不含空格'],
  ['~下标~', '下标，标记内不含空格'],
  ['`行内代码`', '行内代码片段'],
  ['[文字](https://…)', '行内链接，可补尾注 "标题"'],
  ['![说明](图片路径)', '图片：网络地址与本地文件均可；本地图片写入同名资源夹'],
  ['$E=mc^2$', '行内公式（KaTeX）'],
  ['行尾两个空格', '段内强制换行（普通换行会并入同一段）'],
];

export default function HelpPanel({ lang, t, onRestoreWelcome, onClearAll, onClose }: HelpPanelProps) {
  const sections = lang === 'en' ? HELP_EN : HELP_ZH;
  return (
    <div className="md-modal-mask" onMouseDown={onClose}>
      <div className="md-modal md-modal-help" onMouseDown={(event) => event.stopPropagation()}>
        <div className="md-modal-head">
          <span>{t('help.title')}</span>
          <button className="md-icon-btn md-icon-btn-sm" onClick={onClose} title={t('find.close')}>
            <X size={15} />
          </button>
        </div>
        <div className="md-modal-body">
          {sections.map((section) => (
            <section className="md-help-section" key={section.title}>
              <h4 className="md-modal-title">{section.title}</h4>
              <ul className="md-help-list">
                {section.items.map((item, index) => (
                  <li key={index}>
                    {item.label ? <strong>{item.label}</strong> : null}
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="md-help-section">
            <h4 className="md-modal-title">{t('fmt.syntax')}</h4>
            <p className="md-help-group">块级结构</p>
            <table className="md-help-table">
              <tbody>
                {SYNTAX_BLOCK.map(([key, desc]) => (
                  <tr key={key}>
                    <td><code>{key}</code></td>
                    <td>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="md-help-group">行内标记</p>
            <table className="md-help-table">
              <tbody>
                {SYNTAX_INLINE.map(([key, desc]) => (
                  <tr key={key}>
                    <td><code>{key}</code></td>
                    <td>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
        <div className="md-modal-foot">
          <button className="md-btn" onClick={onRestoreWelcome}>{t('help.restore')}</button>
          <button className="md-btn md-btn-danger" onClick={onClearAll}>{t('help.clearAll')}</button>
          <button className="md-btn md-btn-primary" onClick={onClose}>{t('help.close')}</button>
        </div>
      </div>
    </div>
  );
}
