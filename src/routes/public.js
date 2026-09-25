const express = require("express");
const sql = require("../db");
const { loadContent, serializeCases } = require("../lib/cms");
const { isUuid } = require("../lib/validation");

const router = express.Router();

// GET /api/public/site — conteúdo do site + cases publicados (usado no build SSG e no navegador)
// ?full=1 inclui o corpo completo dos cases (build das páginas /cases/:slug)
router.get("/public/site", async (req, res) => {
    try {
        const full = req.query.full === "1";
        const [{ content, latest }, rows] = await Promise.all([
            loadContent(),
            sql`SELECT * FROM cases WHERE publicado ORDER BY ordem, id`,
        ]);
        const cases = await serializeCases(rows, { full });
        const versao = Math.max(latest, ...rows.map((c) => new Date(c.atualizado_em).getTime()), 0);
        const etag = `"site-${versao}-${rows.length}-${full ? 1 : 0}"`;
        res.setHeader("ETag", etag);
        // no-cache + ETag: o navegador sempre revalida (304 barato) — edição do painel aparece na hora
        res.setHeader("Cache-Control", "no-cache");
        if (req.headers["if-none-match"] === etag) return res.status(304).end();
        res.json({ versao, conteudo: content, cases });
    } catch (err) {
        console.error("Erro ao carregar conteúdo público:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// GET /api/public/cases/:slug — case publicado + anterior/próximo
router.get("/public/cases/:slug", async (req, res) => {
    const slug = String(req.params.slug).toLowerCase().slice(0, 120);
    try {
        const rows = await sql`SELECT * FROM cases WHERE publicado ORDER BY ordem, id`;
        const i = rows.findIndex((c) => c.slug.toLowerCase() === slug);
        if (i === -1) return res.status(404).json({ error: "Case não encontrado." });
        const [item] = await serializeCases([rows[i]]);
        const neighbor = (c) => (c ? { slug: c.slug, cliente: c.cliente } : null);
        res.setHeader("Cache-Control", "no-cache");
        res.json({ case: item, anterior: neighbor(rows[i - 1] || rows[rows.length - 1]), proximo: neighbor(rows[i + 1] || rows[0]) });
    } catch (err) {
        console.error("Erro ao carregar case:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// GET /api/media/:id/:largura.:formato — variantes imutáveis (cache de 1 ano)
router.get("/media/:id/:file", async (req, res) => {
    const m = /^(\d{2,4})\.(avif|webp)$/.exec(req.params.file);
    if (!isUuid(req.params.id) || !m) return res.status(404).end();
    const [, w, fmt] = m;
    try {
        // Largura pedida ou a mais próxima disponível
        const rows = await sql`
          SELECT conteudo FROM media_variants
          WHERE media_id = ${req.params.id} AND formato = ${fmt}
          ORDER BY ABS(largura - ${Number(w)}) LIMIT 1`;
        if (rows.length === 0) return res.status(404).end();
        res.setHeader("Content-Type", `image/${fmt}`);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end(rows[0].conteudo);
    } catch (err) {
        console.error("Erro ao servir mídia:", err);
        res.status(500).end();
    }
});

module.exports = router;
