/**
 * MarkDesk 桌面版 · 渲染层入口
 * 复用原型层同一套组件与逻辑（零分叉）：src/prototypes/markdesk/
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import MarkDeskApp from '../../src/prototypes/markdesk/index';

const container = document.getElementById('root');
if (!container) throw new Error('#root 容器缺失，渲染层无法挂载');

createRoot(container).render(<MarkDeskApp />);
