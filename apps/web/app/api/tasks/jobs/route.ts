import { handler } from "@calcom/features/tasker/api/jobs";
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";

export const POST = defaultResponderForAppDir(handler);
