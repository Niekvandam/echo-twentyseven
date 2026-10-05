> Historische audit van de verse clone. Inmiddels staan de Vercel-services live.
> Zie [deploymentstatus en resterend werk](echo/vercel/README.md) voor de actuele situatie.
> De oorspronkelijke conclusie hieronder beschrijft de repo vóór de Vercel-aanpassingen.

# Twentyseven: validatie en implementatieplan

## Conclusie

De frontend bouwt vanuit deze clone. De volledige applicatie is een combinatie
van een React-frontend, Python-services en opslag. De bestaande backend draait
als meerdere permanente processen; de repository is niet ingericht als een
volledig Vercel-project.

De route met de minste wijzigingen is Vercel voor dashboard en deelnemersportal,
met een eigen containeromgeving voor de backend. Alleen Vercel gebruiken vereist
een afzonderlijk herontwerp van de backend en taakverwerking.

## Uitgevoerde validatie

- `pnpm install --frozen-lockfile`: geslaagd, lockfile ongewijzigd.
- `pnpm build`: TypeScript en Vite-productiebundel geslaagd.
- Bestaande tests voor portal-sharing, app-versies en chat-routering: 24 tests
  geslaagd in 3 bestanden, uitgevoerd met Node 22.22.0.
- Vercel CLI-account toegankelijk. Inspiratieproject gevonden onder
  `handpicked-lab/roundtable-pulse`.
- Namen en omgevingen van Vercel-variabelen gecontroleerd. Geen secrets naar deze
  repo gekopieerd.
- Docker CLI aanwezig, maar de daemon niet bereikbaar. Backend, schema-import,
  login, opname en verwerking zijn daarom nog niet end-to-end gevalideerd.
- Geen deployment of wijzigingen aan een bestaande database uitgevoerd.

Buildwaarschuwingen: verouderde Browserslist-data en een JavaScript-bundel van
circa 4,56 MB vóór gzip. Dit blokkeert de build niet; laadtijd moet bij de
browsercontrole worden meegenomen. De uitgevoerde tests dekken niet de volledige app.

## Hoe de code werkt

| Onderdeel | Code | Benodigde runtime |
| --- | --- | --- |
| Dashboard en deelnemersportal | `echo/frontend` | Statische Vite-build op Vercel |
| API, authenticatiecontrole en analyse | `echo/server/dembrane/main.py` | Python 3.11 / FastAPI |
| Accounts, rechten, collecties en bestanden | `echo/directus` | Directus |
| Achtergrondverwerking | `echo/mprocs.yaml`, `echo/server/prod-worker*.sh` | Dramatiq: network, cpu, ticks |
| Periodieke taken | `echo/server/prod-scheduler.sh` | Schedulerproces |
| Agentic Ask | `echo/agent` | Apart Python-proces, poort 8001 |
| Database | Directus en Python-backend | PostgreSQL met pgvector |
| Wachtrijen en gedeelde status | Backend en workers | Redis/Valkey |
| Audio en bestanden | Backend en Directus | S3-compatibele opslag |

De frontend praat rechtstreeks met Directus én met FastAPI. Een nieuwe database
alleen is daarom onvoldoende: Directus-schema, rechten, authenticatieconfiguratie
en de workers horen bij dezelfde installatie.

## Concrete bevindingen vóór deployment

1. `echo/frontend/src/config.ts` kiest configuratie op basis van hostname.
   Onbekende hostnames, waaronder nieuwe Vercel-previews, vallen terug op
   `echo-next.dembrane.com`. Voor deze fork moeten eigen API-, Directus-, dashboard-
   en portaladressen worden geconfigureerd. Ook analytics, feedbacklinks en
   contactverwijzingen moeten een eigen configuratie krijgen.
2. De deelnemersrouter wordt gekozen voor `portal.*` of lokale poort 5174.
   Twee willekeurige Vercel-projectnamen geven dus niet vanzelf een dashboard
   en portal. Gebruik eigen domeinen of expliciete deploymentconfiguratie.
3. `echo/frontend/vercel.json` bevat Dembrane-specifieke CSP-hosts.
   Voeg eigen services, opslag en ElevenLabs toe. Stem ook de backend-CORS,
   Directus-CORS, cookies en uitnodigings-/reset-URL's af op de eigen domeinen.
4. `echo/.devcontainer/docker-compose.yml` mount `./init.sql`, maar dat bestand
   ontbreekt in deze clone. Herstel dit en borg installatie van pgvector.
5. `docker-compose-s3.yml` probeert bucketinitialisatie uit te voeren voordat
   MinIO start. MinIO staat bovendien niet op het expliciete netwerk van de
   overige services. Gebruik een healthcheck en aparte bucketinitialisatie;
   verifieer interne én browserbereikbare opslagadressen.
6. De server-Dockerfile installeert via `uv sync`, maar start met een kale
   `uvicorn` buiten de virtualenv. Gebruik een expliciet `uv run`-startcommando
   of het bestaande productiescript. Deze bevinding is statisch; het image is
   nog niet gebouwd.
7. De voorbeeldconfiguratie is geen direct werkend env-bestand. Ze bevat
   placeholders en kiest Vertex-transcriptie zonder ingevulde service-account.
   LLM-groepen, embeddings en transcriptie moeten afzonderlijk worden ingesteld.
8. De bestaande Directus-snapshots moeten op een eigen database worden toegepast.
   Neem ook de aanvullende membership-indexen uit
   `echo/docs/database_migrations.md` mee. Test daarna account, organisatie,
   workspace en projectaanmaak.

## Wat uit twentyseven-ai-inspo bruikbaar is

Bron: `/Users/niek/Documents/Projects/twentyseven-ai-inspo`.

- Branding: donker groen palet in `lib/theme.ts` en `app/globals.css`, Gellix
  Regular/SemiBold in `public/fonts`, ontwerpbron onder `design`.
- Integratiepatroon: `components/transcriber/useSttSession.ts` gebruikt
  ElevenLabs `useScribe`; `app/api/stt-token/route.ts` maakt eenmalige tokens.
- Vercel Production bevat `ELEVENLABS_API_KEY` en
  `GOOGLE_GENERATIVE_AI_API_KEY`. Hun werking en toegestane API-rechten zijn nog
  niet getest. Deze keys ontbreken in de bekeken lokale `.env.local` en zijn
  niet aanwezig in de bekeken Preview-lijst.
- Neon-databaseconfiguratie is aanwezig, maar Neon Auth vervangt Directus Auth
  niet zonder een migratie. Gebruik een aparte database of geïsoleerde branch
  voor deze app; pas geen Echo-schema toe op de bestaande inspiratie-database.
- `OPERATOR_SECRET` hoort bij de tafel-app. De nieuwe integratie moet aansluiten
  op Echo's project- en deelnemerstoegang.

Branding hoort centraal in `src/colors.ts`, `src/theme.tsx`,
`src/hooks/useAppPreferences.tsx`, `src/index.css` en de logo-componenten.
Alleen een whitelabel-logo instellen neemt het kleurenpalet en de fonts niet over.

## ElevenLabs: live transcriptie

Gewenst: deelnemersgesprekken live transcriberen, zonder terugpratende agent.

Voorgestelde gegevensstroom:

1. Portal vraagt een kortlevend eenmalig token aan bij de eigen backend.
2. Backend controleert deelname aan het project en beperkt tokenaanvragen.
3. Browser streamt microfoonaudio rechtstreeks naar ElevenLabs Scribe Realtime.
4. Voorlopige tekst verschijnt direct. Definitieve segmenten worden met een
   stabiel segment-ID en tijdstip naar de eigen backend verstuurd.
5. Backend bewaart segmenten idempotent: een retry mag geen dubbele tekst maken.
   Bestaande samenvattingen, chat en rapporten lezen dezelfde gespreksdata.

Er bestaat al een `upload-text`-endpoint in
`echo/server/dembrane/api/participant.py`. `ConversationService.create_chunk`
accepteert tekst zonder audio en slaat dan de audio-worker over. Dat is een
bruikbaar aansluitpunt, maar het huidige endpoint maakt bij iedere POST een
nieuw chunk-ID en is dus nog niet geschikt voor betrouwbare realtime-retries.

Controleer daarnaast stop/final flush, reconnects, offline buffering,
gespreksafronding en privacy-instellingen. Als audio-opslag behouden blijft,
moet die dezelfde segmenten volgen en geen tweede transcriptie starten die
ElevenLabs-tekst overschrijft. Voor bestaande audio-uploadfunctionaliteit is
een afzonderlijk batchtranscriptiepad nodig.

Officiële referenties:

- [ElevenLabs client-side streaming](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming)
- [Eenmalige tokens](https://elevenlabs.io/docs/api-reference/tokens/create)
- [Vercel Functions](https://vercel.com/docs/functions)

## Volgorde om dit werkend te krijgen

1. Backend-hosting vaststellen en een geïsoleerde ontwikkelomgeving opstarten.
2. Opstartproblemen herstellen; eigen database, Directus-schema, Redis en
   opslag aansluiten. Eerst login → project → deelnemer → opgeslagen tekst testen.
3. Eigen frontendconfiguratie en Twentyseven-theme toevoegen. Dashboard en
   deelnemersportal als Vercel-previews publiceren tegen de eigen backend.
4. ElevenLabs-tokenendpoint, browserstream en betrouwbare segmentopslag bouwen.
5. End-to-end testen: microfoon → live tekst → herladen → afronden → samenvatting
   → Ask/rapport. Ook mobiel, geweigerde microfoon en reconnect testen.
6. Productiedomeinen, secrets per omgeving en productie-deployment instellen.

Open: welk bestaand server- of containerplatform beschikbaar is voor de backend.
De frontend-build is gevalideerd; een werkende volledige deployment is nog niet
aangetoond.
