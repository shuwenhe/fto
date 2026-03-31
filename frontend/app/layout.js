import './globals.css';

export const metadata = {
  title: 'FTO 专利防侵权',
  description: 'FTO 专利防侵权分析系统',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
