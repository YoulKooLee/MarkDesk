/**
 * mammoth 浏览器构建的类型声明（包体未自带 .d.ts）
 * 追溯：LLD V2.0 §五 DocxToMd ｜ SRS V2.0 F-3.6（3.5.3.6）
 */
declare module 'mammoth/mammoth.browser.js' {
  export interface MammothMessage {
    type: string;
    message: string;
  }
  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: Record<string, unknown>,
  ): Promise<{ value: string; messages: MammothMessage[] }>;
}
