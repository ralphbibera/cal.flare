import { AuthGuard } from "@nestjs/passport";

export class WebSessionGuard extends AuthGuard("web-session") {
  constructor() {
    super();
  }
}
