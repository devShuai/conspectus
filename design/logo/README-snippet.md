<!-- 放在 conspectus README.md 顶部,GitHub 按读者主题自动切换 -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img alt="conspectus 订阅资产" src="docs/assets/logo-light.svg" width="300">
</picture>

# conspectus

订阅资产管理中心。

conspectus 拉丁本义&ldquo;一览、总览&rdquo;。图形:四格总览网格,右上一格砖红填实 —— 一眼扫过所有资产,有一项需要注意。

---

## 配色

| 角色 | 明色底 | 暗色底 |
| --- | --- | --- |
| 图标底块（仅 favicon） | #14161F | #14161F |
| 格线 | #14161F | #F2F3F7 |
| 高亮格（强调） | #C4553C | #E07A5F |
| 字标 | #14161F | #F2F3F7 |
| 副标文字 | #6B6E7B | #9A9DA8 |

四兄弟强调色:specus 紫罗兰 #7A5CE6 / #9B82FF,certus 琥珀金 #C98A1E / #E8B34A,scriptus 青绿 #2A8C8C / #4FB8B0,conspectus 砖红 #C4553C / #E07A5F。共用 #14161F 深灰骨架。

## 文件放置

| 文件 | 仓库位置 |
| --- | --- |
| logo-light.svg / logo-dark.svg | docs/assets/ |
| logo-mark.svg / logo-mark-dark.svg | docs/assets/ |
| logo.svg | public/logo.svg |
| favicon.svg / favicon-32.svg / favicon-16.svg | public/ |
| AppLogo.tsx | src/components/AppLogo.tsx |

横版字标不带深色底块,直接落在页面上;favicon 带底块。conspectus 字标较长,横版画布为 300×64（其余三个产品为 280×64）。

### index.html 引用

```html
<link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg" />
<link rel="icon" type="image/svg+xml" sizes="32x32" href="/favicon-32.svg" />
<link rel="icon" type="image/svg+xml" sizes="16x16" href="/favicon-16.svg" />
```

小尺寸:32px 笔画加到 6,16px 四格全部转实心。每档单独出图。
