# Configure integrations

Use the same provider registrations and public callback paths as Cal.diy. Cloudflare changes hosting and secret storage, not the provider account's consent requirements.
Use your deployment origin wherever `<WEBAPP_URL>` appears below.

For local development, put consumed server configuration in ignored `.dev.vars` files. For deployment, use Worker secrets.
Some apps read installation keys from **Settings → Admin → Apps** rather than environment variables. Keep that app's key schema and never expose account tokens in browser configuration.
Existing provider guides may say `.env`; translate that storage instruction to the [Cloudflare secret configuration](cloudflare.md#configure-local-secrets).

## Connect an integration

1. Register an OAuth application or obtain an API key from the provider, if the app requires one.
2. Register its exact callback URL. Keep development and production URLs separate where the provider requires that.
3. Set the installation credentials through Worker secrets or the app's admin key form, according to the adapter.
4. Ensure app-store metadata is populated by the D1 seed/sync flow, then install or enable the app.
5. Connect the intended user or team account and select destination calendars, calendars checked for conflicts, or event-type settings.
6. Verify create, update, cancel, refresh and error handling for the effects you use.

A catalog link may need no credentials. Calendar, conferencing, CRM and payment apps can require different account permissions.
The [complete catalog](#complete-integration-catalog) links every definition and each existing per-app guide.

## Google Calendar and Meet

1. Create a Google Cloud project and enable Google Calendar API.
2. Configure its OAuth consent screen and test users or published-app audience as appropriate.
3. Create a Web application OAuth client and register `<WEBAPP_URL>/api/integrations/googlecalendar/callback`.
4. Download the client JSON and store the complete JSON string in `GOOGLE_API_CREDENTIALS`. The existing configuration reads its `web.client_id` and `web.client_secret` fields.
5. Enable Google Calendar in the app store, connect the account and choose its calendars. Google Meet uses the same Google credential setup.

For Google login, also register `<WEBAPP_URL>/api/auth/callback/google` and set `GOOGLE_LOGIN_ENABLED=true`.
Preserve the Calendar permissions and offline access requested by the adapter; login-only consent is not sufficient for calendar operations.
See [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) and the [Google adapter](../packages/app-store/googlecalendar).

## Microsoft 365 and Teams

1. Register a Web application in [Microsoft Entra](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) for the account types you intend to support.
2. Register `<WEBAPP_URL>/api/integrations/office365calendar/callback`.
3. Store the Application client ID as `MS_GRAPH_CLIENT_ID` and the client-secret value as `MS_GRAPH_CLIENT_SECRET` where consumed by the installation.
4. Configure and consent to the Microsoft Graph permissions requested by the [calendar adapter](../packages/app-store/office365calendar).
5. Connect the Microsoft account, select its calendars and enable Teams on the intended event types. The Teams integration requires a work or school account.

Microsoft login is separate from calendar installation. Its public callback remains `<WEBAPP_URL>/api/auth/callback/azure-ad`, gated by the retained identity configuration and `OUTLOOK_LOGIN_ENABLED` setting.

## Zoom

1. Create an OAuth app in [Zoom Marketplace](https://marketplace.zoom.us/).
2. Set `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` as server-side configuration.
3. Register `<WEBAPP_URL>/api/integrations/zoomvideo/callback` and its allowed redirect entry.
4. Grant the meeting/user permissions requested by the [Zoom adapter](../packages/app-store/zoomvideo), then connect the account and select Zoom for an event type.

Verify meeting creation, updates and cancellation with the intended Zoom account. An OAuth callback alone does not prove those permissions.

## Cal Video and Daily

1. Obtain an API key from your [Daily developer dashboard](https://dashboard.daily.co/developers).
2. Store it as `DAILY_API_KEY`, then enable the Daily integration for the event types that use Cal Video.
3. Configure `DAILY_WEBHOOK_SECRET` and `DAILY_MEETING_ENDED_WEBHOOK_SECRET` when enabling the corresponding webhook features.
4. Set `DAILY_SCALE_PLAN` only when the account supports the features it enables.

Keep the [Daily adapter's](../packages/app-store/dailyvideo) room, recording and meeting-ended behavior. Verify the room URL and the enabled post-meeting effects.

## Basecamp

Register an application at the [37signals integrations dashboard](https://launchpad.37signals.com/integrations).
Use `<WEBAPP_URL>/api/integrations/basecamp3/callback` as its OAuth redirect URL.
Configure `BASECAMP3_CLIENT_ID`, `BASECAMP3_CLIENT_SECRET` and `BASECAMP3_USER_AGENT`.
The User-Agent identifies your application and support contact; it is not the OAuth client secret.
Connect the account through the app store and verify the [Basecamp adapter](../packages/app-store/basecamp3) against the intended product/account.

## HubSpot

Create an OAuth application in the [HubSpot developer portal](https://developers.hubspot.com/).
Set `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`, with `<WEBAPP_URL>/api/integrations/hubspot/callback` as the redirect URL.
Grant the CRM scopes requested by the [HubSpot adapter](../packages/app-store/hubspot).
Connect the account and verify contact and meeting effects for an actual synthetic booking.

## Zoho

Use [Zoho API Console](https://api-console.zoho.com/) to register a server-based application.
Choose the callback for the app you enable:

| App | Callback and guide |
| --- | --- |
| Zoho CRM | `<WEBAPP_URL>/api/integrations/zohocrm/callback`; [adapter/key handling](../packages/app-store/zohocrm). |
| Zoho Calendar | `<WEBAPP_URL>/api/integrations/zohocalendar/callback`; [setup guide](../packages/app-store/zohocalendar/README.md). |
| Zoho Bigin | `<WEBAPP_URL>/api/integrations/zoho-bigin/callback`; [setup guide](../packages/app-store/zoho-bigin/README.md). |

Store the client ID and secret using the app's admin keys or retained server configuration. Configure Multi-DC when your deployment uses more than one Zoho data center.
Keep the provider-specific scopes, account region and refresh behavior in each adapter.

## Payments

For Stripe, configure `NEXT_PUBLIC_STRIPE_PUBLIC_KEY`, `STRIPE_PRIVATE_KEY`, `STRIPE_CLIENT_ID` and the applicable `STRIPE_WEBHOOK_SECRET`.
Register `<WEBAPP_URL>/api/integrations/stripepayment/callback` for Connect OAuth.
Use the [Stripe guide](../packages/app-store/stripepayment/README.md) for provider registration and webhook configuration.

The baseline contains community-edition Stripe webhook stubs. Credential setup does not turn those stubs into payment fulfillment.
Use the [payment behavior contract](porting/behavior.md#d_payments) when deciding which payment flow is being accepted.
Other payment apps have their own credential, currency, signature and receipt rules; do not reuse Stripe settings for them.
[HitPay](../packages/app-store/hitpay/README.md), [PayPal](../packages/app-store/paypal), [BTCPay](../packages/app-store/btcpayserver) and [Alby](../packages/app-store/alby) retain their own configuration.

## Automation and webhooks

Follow the [Zapier guide](../packages/app-store/zapier/README.md) or [Make guide](../packages/app-store/make/README.md) for app API keys and webhook registration.
Use your public Cal.flare origin for provider connections, not an inaccessible local URL.
For direct webhooks, configure event selection and signing, then verify the receiver's payload and the source-specific retry behavior.
Where delivery is queued, Cloudflare Queues supplies the transport. Source success, failure, synchronous fallback and retry rules still apply.

## Rate limiting

The Cloudflare target replaces external limiter storage with the `RUNTIME_STATE` Durable Object.
Preserve original enabled/disabled configuration, windows, namespaces, fail-open behavior and response shape.
Provisioning a Durable Object alone must not enable limiting that the installation leaves disabled.
See [job and state configuration](porting/architecture.md#jobs-ephemeral-state-and-integrations).

## Complete integration catalog

Every app-store definition in the baseline is indexed below. Some are external catalog links rather than hosted API integrations.
Use the specific setup guide where available, then the linked definition and source for its key schema, enablement and callback behavior.
The [static integration inventory](porting/inventory/integrations.tsv) records the underlying source paths.

| Integration | Setup | Definition |
| --- | --- | --- |
| Alby | [App store](#connect-an-integration) | [Configuration](../packages/app-store/alby/config.json) |
| Amie | [App store](#connect-an-integration) | [Configuration](../packages/app-store/amie/config.json) |
| Apple Calendar | [App store](#connect-an-integration) | [Configuration](../packages/app-store/applecalendar/_metadata.ts) |
| Attio | [App store](#connect-an-integration) | [Configuration](../packages/app-store/attio/config.json) |
| Autocheckin | [App store](#connect-an-integration) | [Configuration](../packages/app-store/autocheckin/config.json) |
| BAA for HIPAA | [App store](#connect-an-integration) | [Configuration](../packages/app-store/baa-for-hipaa/config.json) |
| Basecamp3 | [Guide](#basecamp) | [Configuration](../packages/app-store/basecamp3/config.json) |
| Bolna | [App store](#connect-an-integration) | [Configuration](../packages/app-store/bolna/config.json) |
| BTCPayServer | [App store](#connect-an-integration) | [Configuration](../packages/app-store/btcpayserver/config.json) |
| CalDav (Beta) | [App store](#connect-an-integration) | [Configuration](../packages/app-store/caldavcalendar/_metadata.ts) |
| Campfire | [App store](#connect-an-integration) | [Configuration](../packages/app-store/campfire/config.json) |
| Caretta | [App store](#connect-an-integration) | [Configuration](../packages/app-store/caretta/config.json) |
| Chatbase | [App store](#connect-an-integration) | [Configuration](../packages/app-store/chatbase/config.json) |
| Clara | [App store](#connect-an-integration) | [Configuration](../packages/app-store/clara/config.json) |
| Clic | [App store](#connect-an-integration) | [Configuration](../packages/app-store/clic/config.json) |
| Close.com | [App store](#connect-an-integration) | [Configuration](../packages/app-store/closecom/config.json) |
| Notion Calendar | [App store](#connect-an-integration) | [Configuration](../packages/app-store/cron/config.json) |
| Cal Video | [Guide](#cal-video-and-daily) | [Configuration](../packages/app-store/dailyvideo/_metadata.ts) |
| Databuddy | [App store](#connect-an-integration) | [Configuration](../packages/app-store/databuddy/config.json) |
| Deel | [App store](#connect-an-integration) | [Configuration](../packages/app-store/deel/config.json) |
| Demodesk | [App store](#connect-an-integration) | [Configuration](../packages/app-store/demodesk/config.json) |
| dialpad | [App store](#connect-an-integration) | [Configuration](../packages/app-store/dialpad/config.json) |
| Discord | [App store](#connect-an-integration) | [Configuration](../packages/app-store/discord/config.json) |
| Dub | [App store](#connect-an-integration) | [Configuration](../packages/app-store/dub/config.json) |
| 8x8 | [App store](#connect-an-integration) | [Configuration](../packages/app-store/eightxeight/config.json) |
| Element Call | [App store](#connect-an-integration) | [Configuration](../packages/app-store/element-call/config.json) |
| ElevenLabs | [App store](#connect-an-integration) | [Configuration](../packages/app-store/elevenlabs/config.json) |
| Microsoft Exchange 2013 Calendar | [App store](#connect-an-integration) | [Configuration](../packages/app-store/exchange2013calendar/_metadata.ts) |
| Microsoft Exchange 2016 Calendar | [App store](#connect-an-integration) | [Configuration](../packages/app-store/exchange2016calendar/_metadata.ts) |
| Microsoft Exchange | [App store](#connect-an-integration) | [Configuration](../packages/app-store/exchangecalendar/config.json) |
| Facetime | [App store](#connect-an-integration) | [Configuration](../packages/app-store/facetime/config.json) |
| Famulor | [App store](#connect-an-integration) | [Configuration](../packages/app-store/famulor/config.json) |
| Fathom | [App store](#connect-an-integration) | [Configuration](../packages/app-store/fathom/config.json) |
| Feishu Calendar | [App store](#connect-an-integration) | [Configuration](../packages/app-store/feishucalendar/_metadata.ts) |
| fonio.ai | [App store](#connect-an-integration) | [Configuration](../packages/app-store/fonio-ai/config.json) |
| Framer | [App store](#connect-an-integration) | [Configuration](../packages/app-store/framer/config.json) |
| Google Analytics | [App store](#connect-an-integration) | [Configuration](../packages/app-store/ga4/config.json) |
| Giphy | [App store](#connect-an-integration) | [Configuration](../packages/app-store/giphy/_metadata.ts) |
| Google Calendar | [Guide](#google-calendar-and-meet) | [Configuration](../packages/app-store/googlecalendar/_metadata.ts) |
| Google Meet | [Guide](#google-calendar-and-meet) | [Configuration](../packages/app-store/googlevideo/_metadata.ts) |
| Granola | [App store](#connect-an-integration) | [Configuration](../packages/app-store/granola/config.json) |
| Greetmate.ai | [App store](#connect-an-integration) | [Configuration](../packages/app-store/greetmate-ai/config.json) |
| Google Tag Manager | [App store](#connect-an-integration) | [Configuration](../packages/app-store/gtm/config.json) |
| HitPay | [Guide](../packages/app-store/hitpay/README.md) | [Configuration](../packages/app-store/hitpay/config.json) |
| Horizon Workrooms | [App store](#connect-an-integration) | [Configuration](../packages/app-store/horizon-workrooms/config.json) |
| HubSpot CRM | [Guide](#hubspot) | [Configuration](../packages/app-store/hubspot/_metadata.ts) |
| Huddle01 | [Guide](../packages/app-store/huddle01video/README.md) | [Configuration](../packages/app-store/huddle01video/_metadata.ts) |
| ICS Feed | [App store](#connect-an-integration) | [Configuration](../packages/app-store/ics-feedcalendar/config.json) |
| Insihts | [App store](#connect-an-integration) | [Configuration](../packages/app-store/insihts/config.json) |
| Intercom | [App store](#connect-an-integration) | [Configuration](../packages/app-store/intercom/config.json) |
| Jelly | [App store](#connect-an-integration) | [Configuration](../packages/app-store/jelly/config.json) |
| Jitsi Video | [App store](#connect-an-integration) | [Configuration](../packages/app-store/jitsivideo/_metadata.ts) |
| Lark Calendar | [App store](#connect-an-integration) | [Configuration](../packages/app-store/larkcalendar/_metadata.ts) |
| Lindy | [App store](#connect-an-integration) | [Configuration](../packages/app-store/lindy/config.json) |
| Linear | [App store](#connect-an-integration) | [Configuration](../packages/app-store/linear/config.json) |
| Lyra | [App store](#connect-an-integration) | [Configuration](../packages/app-store/lyra/config.json) |
| Make | [Guide](../packages/app-store/make/README.md) | [Configuration](../packages/app-store/make/config.json) |
| Matomo | [App store](#connect-an-integration) | [Configuration](../packages/app-store/matomo/config.json) |
| Meta Pixel | [App store](#connect-an-integration) | [Configuration](../packages/app-store/metapixel/config.json) |
| Millis AI | [App store](#connect-an-integration) | [Configuration](../packages/app-store/millis-ai/config.json) |
| Mirotalk | [App store](#connect-an-integration) | [Configuration](../packages/app-store/mirotalk/config.json) |
| Mock Payment App | [App store](#connect-an-integration) | [Configuration](../packages/app-store/mock-payment-app/config.json) |
| Monobot CX | [App store](#connect-an-integration) | [Configuration](../packages/app-store/monobot/config.json) |
| n8n | [App store](#connect-an-integration) | [Configuration](../packages/app-store/n8n/config.json) |
| Nextcloud Talk | [Guide](../packages/app-store/nextcloudtalk/README.md) | [Configuration](../packages/app-store/nextcloudtalk/config.json) |
| Outlook Calendar | [Guide](#microsoft-365-and-teams) | [Configuration](../packages/app-store/office365calendar/_metadata.ts) |
| Microsoft 365/Teams (Requires work/school account) | [Guide](#microsoft-365-and-teams) | [Configuration](../packages/app-store/office365video/_metadata.ts) |
| Paypal | [App store](#connect-an-integration) | [Configuration](../packages/app-store/paypal/config.json) |
| Ping.gg | [App store](#connect-an-integration) | [Configuration](../packages/app-store/ping/config.json) |
| Pipedream | [App store](#connect-an-integration) | [Configuration](../packages/app-store/pipedream/config.json) |
| Pipedrive CRM | [Guide](../packages/app-store/pipedrive-crm/README.md) | [Configuration](../packages/app-store/pipedrive-crm/config.json) |
| Plausible | [App store](#connect-an-integration) | [Configuration](../packages/app-store/plausible/config.json) |
| Posthog | [App store](#connect-an-integration) | [Configuration](../packages/app-store/posthog/config.json) |
| QR Code | [App store](#connect-an-integration) | [Configuration](../packages/app-store/qr_code/config.json) |
| Raycast | [App store](#connect-an-integration) | [Configuration](../packages/app-store/raycast/config.json) |
| Retell AI | [App store](#connect-an-integration) | [Configuration](../packages/app-store/retell-ai/config.json) |
| Riverside | [App store](#connect-an-integration) | [Configuration](../packages/app-store/riverside/config.json) |
| Roam | [App store](#connect-an-integration) | [Configuration](../packages/app-store/roam/config.json) |
| Salesforce | [Guide](../packages/app-store/salesforce/README.md) | [Configuration](../packages/app-store/salesforce/config.json) |
| Salesroom | [App store](#connect-an-integration) | [Configuration](../packages/app-store/salesroom/config.json) |
| Sendgrid | [App store](#connect-an-integration) | [Configuration](../packages/app-store/sendgrid/config.json) |
| Shimmer Video | [App store](#connect-an-integration) | [Configuration](../packages/app-store/shimmervideo/config.json) |
| Signal | [App store](#connect-an-integration) | [Configuration](../packages/app-store/signal/config.json) |
| Sirius Video | [App store](#connect-an-integration) | [Configuration](../packages/app-store/sirius_video/config.json) |
| Skype | [App store](#connect-an-integration) | [Configuration](../packages/app-store/skype/config.json) |
| Stripe | [Guide](../packages/app-store/stripepayment/README.md) | [Configuration](../packages/app-store/stripepayment/_metadata.ts) |
| Sylaps | [App store](#connect-an-integration) | [Configuration](../packages/app-store/sylapsvideo/config.json) |
| Synthflow | [App store](#connect-an-integration) | [Configuration](../packages/app-store/synthflow/config.json) |
| Tandem Video | [App store](#connect-an-integration) | [Configuration](../packages/app-store/tandemvideo/_metadata.ts) |
| Telegram | [App store](#connect-an-integration) | [Configuration](../packages/app-store/telegram/config.json) |
| telli | [App store](#connect-an-integration) | [Configuration](../packages/app-store/telli/config.json) |
| Twipla | [App store](#connect-an-integration) | [Configuration](../packages/app-store/twipla/config.json) |
| Umami | [App store](#connect-an-integration) | [Configuration](../packages/app-store/umami/config.json) |
| Vimcal | [App store](#connect-an-integration) | [Configuration](../packages/app-store/vimcal/config.json) |
| Vital | [App store](#connect-an-integration) | [Configuration](../packages/app-store/vital/_metadata.ts) |
| Weather in your Calendar | [App store](#connect-an-integration) | [Configuration](../packages/app-store/weather_in_your_calendar/config.json) |
| Webex | [Guide](../packages/app-store/webex/README.md) | [Configuration](../packages/app-store/webex/config.json) |
| WhatsApp | [App store](#connect-an-integration) | [Configuration](../packages/app-store/whatsapp/config.json) |
| Whereby | [App store](#connect-an-integration) | [Configuration](../packages/app-store/whereby/config.json) |
| WipeMyCal | [App store](#connect-an-integration) | [Configuration](../packages/app-store/wipemycalother/_metadata.ts) |
| Wordpress | [App store](#connect-an-integration) | [Configuration](../packages/app-store/wordpress/config.json) |
| Zapier | [Guide](../packages/app-store/zapier/README.md) | [Configuration](../packages/app-store/zapier/_metadata.ts) |
| Zoho Bigin | [Guide](../packages/app-store/zoho-bigin/README.md) | [Configuration](../packages/app-store/zoho-bigin/config.json) |
| Zoho Calendar | [Guide](../packages/app-store/zohocalendar/README.md) | [Configuration](../packages/app-store/zohocalendar/config.json) |
| Zoho CRM | [Guide](#zoho) | [Configuration](../packages/app-store/zohocrm/config.json) |
| Zoom Video | [Guide](#zoom) | [Configuration](../packages/app-store/zoomvideo/_metadata.ts) |
