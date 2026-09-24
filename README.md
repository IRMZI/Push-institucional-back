# PUSH — API do site institucional

API do site da **PUSH**: rastreamento first-party de visitantes, conversões com **Meta Conversions API**, formulário de leads (com webhook/e-mail) e o painel administrativo (`/dashboard` no front — repositório [`Push-institucional-front`](https://github.com/IRMZI/Push-institucional-front)).

**Stack:** Node 20+ · Express 4 · PostgreSQL (`postgres.js`) · zod · bcryptjs · jsonwebtoken · helmet · express-rate-limit.

## Rodando local

```bash
cp .env.example .env        # preencha DATABASE_URL, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD
npm install
npm run migrate             # opcional: a API também roda as migrations ao subir
npm run dev                 # http://localhost:3000/api/health
```

A API **aborta na subida** se faltar `DATABASE_URL`, `JWT_SECRET`, `ADMIN_USERNAME` ou `ADMIN_PASSWORD`.

### Testes

Testes de integração contra um Postgres de teste (cria e limpa os próprios dados):

```bash
DATABASE_URL=postgres://.../push_site_test JWT_SECRET=... ADMIN_USERNAME=admin ADMIN_PASSWORD=... npm test
```

## Rotas (`/api`)

| Método | Rota | Acesso | Uso |
|---|---|---|---|
| GET | `/health` | público | healthcheck (inclui ping no banco) |
| POST | `/auth/login` · GET `/auth/me` | público · auth | login do painel (rate limit: 8 tentativas / 15 min) |
| POST | `/sessions` | público | cria/atualiza a sessão do visitante; conta visitas; first/last-touch |
| POST | `/sessions/:id/events` | público | eventos em lote (aceita `text/plain` do `sendBeacon`) |
| POST | `/conversoes` | público | WhatsApp / Instagram / e-mail / CTA + CAPI |
| POST | `/leads` | público | formulário → lead + conversão `lead_form` + CAPI + webhook/e-mail (rate limit + honeypot) |
| GET | `/dashboard/overview?range=7d` ou `?from=&to=` | auth | KPIs, série diária, origens, campanhas, funil, dispositivos, seções, saúde da CAPI |
| GET · PATCH · DELETE | `/leads`, `/leads/:id` | auth | lista com filtros, detalhe com jornada, status do pipeline |
| POST · DELETE | `/leads/:id/notes`, `/leads/:id/tags` | auth | notas internas e tags |
| GET | `/leads/export.csv` | auth | exportação com os mesmos filtros da lista |
| GET | `/sessions`, `/sessions/:id` | auth | lista e linha do tempo da sessão |
| POST · DELETE | `/sessions/:id/tags` | auth | tags em sessões |
| GET | `/conversoes` · POST `/conversoes/:id/reenviar` | auth | lista com status da CAPI · reenvio manual |
| CRUD | `/tags`, `/campaigns`, `/users` (só admin) | auth | configurações |
| GET · PUT | `/settings/whatsapp-templates` | auth | mensagens prontas do WhatsApp |

Filtros comuns: `range=today|7d|30d|90d` ou `from=YYYY-MM-DD&to=YYYY-MM-DD` (dias no fuso `TZ_REPORTS`), `page`, `limit`.
Leads: `q, status, servico, investimento, origem, campanha, tag`. Sessões: `q, convertido, dispositivo, origem, tag`. Conversões: `tipo, capi_status`.

## Tabelas

`visitor_sessions` · `session_events` · `conversoes` · `leads` · `lead_notes` · `tags` · `session_tags` · `lead_tags` · `campaigns` · `admin_users` · `app_settings`

As migrations ficam em `src/migrate.js` e são **idempotentes** (`IF NOT EXISTS` / `ON CONFLICT`): podem rodar a cada deploy.

## Como o tracking funciona

- **Sessão** (`visitor_sessions.id`): UUID em cookie first-party de 30 dias no navegador. Cada abertura do site é uma **visita** (`visit_id`, evento `visit_start`) — o painel usa isso para separar *visitantes únicos* de *sessões*.
- **First-touch** (`ft_*`) é gravado uma vez e nunca sobrescrito; **last-touch** (`utm_*`) troca sempre que uma visita chega com parâmetros de campanha.
- **IP nunca é gravado**: guardamos só um hash salgado (`ip_hash`). O IP da requisição é usado apenas no envio em tempo real à CAPI.
- **Conversões** são idempotentes por `event_id` — o mesmo ID vai para o Pixel (navegador) e para a CAPI (servidor), e a Meta deduplica.
- **LGPD:** um evento só é enviado à Meta se o visitante aceitou cookies de mídia (`consentimento = all`). Caso contrário a conversão fica registrada com `capi_status = sem_consentimento`.

### Status da CAPI (`conversoes.capi_status`)

`pendente` → `enviado` | `erro` (resposta da Meta em `capi_resposta`, visível no painel) · `sem_consentimento` · `desativado` (sem `META_PIXEL_ID`/`META_CAPI_TOKEN`) · `nao_aplicavel` (Instagram/CTA não viram eventos padrão).

Dados pessoais enviados à Meta (`em`, `ph`, `fn`, `ln`, `external_id`, `country`) vão **sempre em SHA-256**, normalizados (minúsculas, sem acento; telefone em E.164).

### Webhook de lead novo

`POST LEAD_WEBHOOK_URL`:

```json
{
  "evento": "lead.criado",
  "origem": "site-push",
  "lead": {
    "id": 42, "nome": "Maria", "whatsapp": "5551999998888", "whatsapp_formatado": "(51) 99999-8888",
    "email": "maria@exemplo.com", "empresa": "@loja", "servicos": ["Tráfego Pago"],
    "investimento": "R$ 2–5 mil", "mensagem": null, "origem": "meta", "campanha": "leads-set",
    "whatsapp_link": "https://wa.me/5551999998888",
    "painel_url": "https://pushagencia.com.br/dashboard/leads/42"
  }
}
```

Com `LEAD_WEBHOOK_SECRET`, o header `X-Push-Signature: sha256=<hmac do corpo>` permite ao CRM (crm.pushagencia.com.br) validar a origem.

## Deploy (VPS + Coolify)

1. **Banco:** no Coolify, *New Resource → Database → PostgreSQL*. Crie o database `push_site` e copie a *internal URL* para `DATABASE_URL`.
2. **API:** *New Resource → Public Repository/GitHub App* → este repositório, build pack **Railpack** (detecta Node e roda `npm start`).
   - Porta exposta: **3000**.
   - Healthcheck: `GET /api/health`.
   - Variáveis: copie o `.env.example` e preencha. `FRONTEND_URL` precisa conter o domínio do site.
   - Domínio: ex. `https://api.pushagencia.com.br`.
3. Na primeira subida a API roda as migrations e cria o admin de `ADMIN_USERNAME`/`ADMIN_PASSWORD`.

### Primeiro admin e novos usuários

- O usuário de `ADMIN_USERNAME` é criado automaticamente se não existir (a senha do `.env` **não** sobrescreve uma senha já trocada).
- Pelo terminal do container (Coolify → *Terminal*):

```bash
npm run create-admin -- rafael 'uma-senha-forte-aqui' "Rafael" admin
```

  O comando também redefine a senha se o usuário já existir.
- Pelo painel: **Configurações → Usuários** (somente admins).
