import { env } from "cloudflare:workers";
import { handleApi } from "../../server/app.ts";
import { endpoint } from "../../server/http.ts";

export const ALL = endpoint(({ request }) => handleApi(request, { env }));
