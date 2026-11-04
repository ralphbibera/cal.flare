create table "AuthUser" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "calUserId" integer not null unique);

create table "AuthSession" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "AuthUser" ("id") on delete cascade, "calClaims" text not null, "profileContext" text);

create table "AuthAccount" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "AuthUser" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "AuthVerification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create index "AuthSession_userId_idx" on "AuthSession" ("userId");

create index "AuthAccount_userId_idx" on "AuthAccount" ("userId");

create index "AuthVerification_identifier_idx" on "AuthVerification" ("identifier");