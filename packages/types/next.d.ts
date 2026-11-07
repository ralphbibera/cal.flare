import type { IncomingMessage } from "node:http";

import type { CalServerSession } from "@calcom/features/auth/lib/cal-server-session";

export declare module "next" {
  interface NextApiRequest extends IncomingMessage {
    // args is defined by /integrations/[...args] endpoint
    query: Partial<{ [key: string]: string | string[] }> & { args: string[] };
    session?: CalServerSession | null;
    // ⬇ These are needed by @calcom/api
    body: unknown;
    userId: number;
    method: string;
    // session: { user: { id: number } };
    // query: Partial<{ [key: string]: string | string[] }>;
    isAdmin: boolean;
    pagination: { take: number; skip: number };
  }
}

export declare module "next/navigation" {
  interface Params {
    [key: string]: string;
  }
  export declare function useParams(): Params | null;
}
