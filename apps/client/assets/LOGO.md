# Rufajx-DSH 图标

`rufajx-mark.png` 是基于用户提供的如发机械 Logo 生成的应用图标。1254×1254、RGBA、透明背景。保留齿轮和中央拱形 R，移除文字、注册标和底部横线，以适应侧栏和首页的小尺寸显示。网页通过 alpha mask/currentColor 显示，深色主题为白色，浅色主题为深色。

生成方式：Codex 内置 image_gen，transparent_background=true；没有使用外部API Key、Python修图或手工描摹。首版白色图有边缘噪点，被后续清理版替代。原始生成结果保留在Codex generated_images。

最终迭代提示词：

> Edit this logo. Keep the exact central arched R monogram and gear silhouette, but completely remove every speckle, dust spot, scratch, ragged edge, extra white island and texture. Reconstruct it as perfectly clean flat solid BLACK (#000000) geometric vector-like shapes on real TRANSPARENT background. All transparent negative-space channels between the R and gear must be completely empty and pristine. Single ink BLACK only, fully opaque in the mark, no white pixels or gray texture. Crisp smooth edges with antialiasing only at edges. Preserve the square centered composition with 8% transparent margin and bold structure for a 24px app icon. No text. No shadow. No distress effect. Production-ready clean brand logo.
