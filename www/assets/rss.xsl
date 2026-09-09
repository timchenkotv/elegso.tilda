<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:content="http://purl.org/rss/1.0/modules/content/" exclude-result-prefixes="content">
  <xsl:output method="html" encoding="UTF-8"/>
  <xsl:template match="/">
    <html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title><xsl:value-of select="rss/channel/title"/></title><meta name="robots" content="noindex,follow"/>
      <style>body{margin:0;background:#f7f3ec;color:#263e3b;font:17px/1.6 system-ui,sans-serif}main{max-width:900px;margin:auto;padding:56px 24px}a{color:#355a56;text-underline-offset:4px}h1{font:clamp(30px,6vw,48px)/1.2 Georgia,serif;max-width:720px}h2{font:26px/1.3 Georgia,serif}header{padding-bottom:32px;border-bottom:1px solid #d9d0c3}.note{background:#e5dcd0;padding:18px 22px;border-radius:12px}article{padding:22px 0;border-bottom:1px solid #d9d0c3}.meta{font-size:14px;color:#596b65}footer{padding-top:30px}a:focus-visible{outline:3px solid #a04b38;outline-offset:4px}</style>
    </head><body><main><header><a href="/articles/">← Статьи и практика ЭЛЕГСО</a><h1><xsl:value-of select="rss/channel/title"/></h1><p><xsl:value-of select="rss/channel/description"/></p><p class="note">Это лента публикаций. Добавьте адрес этой страницы в программу для чтения лент, чтобы получать новые материалы. Для обычного чтения откройте статью по ссылке ниже.</p></header>
      <xsl:for-each select="rss/channel/item"><article><p class="meta"><xsl:value-of select="category"/></p><h2><a href="{link}"><xsl:value-of select="title"/></a></h2><p><xsl:value-of select="description"/></p><a href="{link}">Читать материал →</a></article></xsl:for-each>
      <footer><a href="/articles/rss.xml">Полные материалы</a> · <a href="/articles/announcements.xml">Короткие анонсы</a> · <a href="/">Главная</a></footer>
    </main></body></html>
  </xsl:template>
</xsl:stylesheet>
