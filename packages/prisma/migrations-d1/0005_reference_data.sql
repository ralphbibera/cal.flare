-- Reference rows and the membership role trigger from the PostgreSQL history at e8afecd.
-- Rows are the end-state of replaying every packages/prisma/migrations file in order; timestamps
-- the source took from NOW() or column defaults use the D1 clock instead.

INSERT INTO "Role" ("id", "name", "description", "color", "type", "updatedAt")
VALUES
  ('owner_role', 'Owner', 'Full access to all resources', '#1BA774', 'SYSTEM', strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')),
  ('admin_role', 'Admin', 'Administrative access to most resources', '#6633EE', 'SYSTEM', strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')),
  ('member_role', 'Member', 'Basic member access', '#EAB308', 'SYSTEM', strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'))
ON CONFLICT ("id") DO NOTHING;

-- gen_random_uuid() equivalent: a random RFC 4122 version 4 UUID per row.
INSERT INTO "RolePermission" ("id", "roleId", "resource", "action")
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  "column1", "column2", "column3"
FROM (VALUES
  ('owner_role', '*', '*'),
  ('admin_role', 'apiKey', 'create'),
  ('admin_role', 'apiKey', 'delete'),
  ('admin_role', 'apiKey', 'findKeyOfType'),
  ('admin_role', 'apiKey', 'read'),
  ('admin_role', 'availability', 'create'),
  ('admin_role', 'availability', 'delete'),
  ('admin_role', 'availability', 'override'),
  ('admin_role', 'availability', 'read'),
  ('admin_role', 'availability', 'update'),
  ('admin_role', 'booking', 'read'),
  ('admin_role', 'booking', 'readOrgAuditLogs'),
  ('admin_role', 'booking', 'readOrgBookings'),
  ('admin_role', 'booking', 'readRecordings'),
  ('admin_role', 'booking', 'readTeamAuditLogs'),
  ('admin_role', 'booking', 'readTeamBookings'),
  ('admin_role', 'booking', 'update'),
  ('admin_role', 'eventType', 'create'),
  ('admin_role', 'eventType', 'delete'),
  ('admin_role', 'eventType', 'read'),
  ('admin_role', 'eventType', 'update'),
  ('admin_role', 'featureOptIn', 'read'),
  ('admin_role', 'featureOptIn', 'update'),
  ('admin_role', 'insights', 'read'),
  ('admin_role', 'ooo', 'create'),
  ('admin_role', 'ooo', 'delete'),
  ('admin_role', 'ooo', 'read'),
  ('admin_role', 'ooo', 'update'),
  ('admin_role', 'organization', 'changeMemberRole'),
  ('admin_role', 'organization', 'impersonate'),
  ('admin_role', 'organization', 'invite'),
  ('admin_role', 'organization', 'listMembers'),
  ('admin_role', 'organization', 'listMembersPrivate'),
  ('admin_role', 'organization', 'manageBilling'),
  ('admin_role', 'organization', 'passwordReset'),
  ('admin_role', 'organization', 'read'),
  ('admin_role', 'organization', 'remove'),
  ('admin_role', 'organization', 'update'),
  ('admin_role', 'organization.attributes', 'create'),
  ('admin_role', 'organization.attributes', 'delete'),
  ('admin_role', 'organization.attributes', 'editUsers'),
  ('admin_role', 'organization.attributes', 'read'),
  ('admin_role', 'organization.attributes', 'update'),
  ('admin_role', 'role', 'create'),
  ('admin_role', 'role', 'delete'),
  ('admin_role', 'role', 'read'),
  ('admin_role', 'role', 'update'),
  ('admin_role', 'routingForm', 'create'),
  ('admin_role', 'routingForm', 'delete'),
  ('admin_role', 'routingForm', 'manage'),
  ('admin_role', 'routingForm', 'read'),
  ('admin_role', 'routingForm', 'update'),
  ('admin_role', 'team', 'changeMemberRole'),
  ('admin_role', 'team', 'create'),
  ('admin_role', 'team', 'impersonate'),
  ('admin_role', 'team', 'invite'),
  ('admin_role', 'team', 'listMembers'),
  ('admin_role', 'team', 'listMembersPrivate'),
  ('admin_role', 'team', 'manageBilling'),
  ('admin_role', 'team', 'read'),
  ('admin_role', 'team', 'remove'),
  ('admin_role', 'team', 'update'),
  ('admin_role', 'watchlist', 'create'),
  ('admin_role', 'watchlist', 'delete'),
  ('admin_role', 'watchlist', 'read'),
  ('admin_role', 'watchlist', 'update'),
  ('admin_role', 'webhook', 'create'),
  ('admin_role', 'webhook', 'delete'),
  ('admin_role', 'webhook', 'read'),
  ('admin_role', 'webhook', 'update'),
  ('admin_role', 'workflow', 'create'),
  ('admin_role', 'workflow', 'delete'),
  ('admin_role', 'workflow', 'read'),
  ('admin_role', 'workflow', 'update'),
  ('member_role', 'availability', 'read'),
  ('member_role', 'availability', 'update'),
  ('member_role', 'booking', 'update'),
  ('member_role', 'eventType', 'read'),
  ('member_role', 'featureOptIn', 'read'),
  ('member_role', 'ooo', 'read'),
  ('member_role', 'organization', 'listMembers'),
  ('member_role', 'organization', 'read'),
  ('member_role', 'organization.attributes', 'read'),
  ('member_role', 'role', 'read'),
  ('member_role', 'routingForm', 'read'),
  ('member_role', 'team', 'listMembers'),
  ('member_role', 'team', 'read'),
  ('member_role', 'webhook', 'read'),
  ('member_role', 'workflow', 'read')
)
-- SQLite requires a WHERE before ON CONFLICT in INSERT ... SELECT to parse it as an upsert.
WHERE true
ON CONFLICT ("roleId", "resource", "action") DO NOTHING;

INSERT INTO "Feature" ("slug", "enabled", "type", "description")
VALUES
  ('active-user-billing', false, 'OPERATIONAL', 'Enable active-user-based billing for teams and organizations'),
  ('attributes', false, 'OPERATIONAL', 'Enable attributes - Custom fields for users and teams.'),
  ('booker-botid', false, 'OPERATIONAL', 'Enable BotID protection for booking endpoints - Protects booking API endpoints from bot traffic using BotID verification.'),
  ('booking-audit', false, 'OPERATIONAL', 'Enable booking audit trails - Track all booking actions and changes for organizations'),
  ('booking-calendar-view', false, 'EXPERIMENT', 'Enable booking calendar view for all users'),
  ('bookings-v3', false, 'EXPERIMENT', 'Enable bookings redesign v3 for all users'),
  ('cal-ai-voice-agents', false, 'OPERATIONAL', 'Enable Cal AI Voice Agents - Allow AI-powered voice agents to make phone calls.'),
  ('cal-video-log-in-overlay', false, 'OPERATIONAL', 'Enable Log In Overlay - Allows system to show a log in overlay on the Cal Video page.'),
  ('calendar-cache', false, 'OPERATIONAL', 'Enable Third Party Calendar Cache - Cache third party calendar events to reduce the number of API calls to third party calendar providers.'),
  ('calendar-cache-serve', false, 'OPERATIONAL', 'Whether to serve calendar cache by default or not on a team/user basis.'),
  ('calendar-subscription-cache', false, 'OPERATIONAL', 'Enable calendar subscription cache'),
  ('calendar-subscription-sync', false, 'OPERATIONAL', 'Enable calendar subscription synchronization'),
  ('delegation-credential', false, 'OPERATIONAL', 'Enable Delegation Credentials - Allows system to act on behalf of Workspace users on third parties such as google,oulook, etc ...'),
  ('disable-signup', false, 'OPERATIONAL', 'Enable to prevent users from signing up'),
  ('domain-wide-delegation', false, 'OPERATIONAL', 'Enable Google Workspace Domain-Wide Delegation - Allows system to act on behalf of Google Workspace users.'),
  ('email-verification', true, 'OPERATIONAL', 'Enable email verification for new users'),
  ('emails', false, 'KILL_SWITCH', 'Enable to prevent any emails being send'),
  ('google-workspace-directory', false, 'OPERATIONAL', 'Enable Google Workspace Directory integration - Syncing of users and groups from Google Workspace to users teams.'),
  ('hwm-seating', false, 'RELEASE', 'High water mark seating for monthly billing - charges for peak seats used during billing period'),
  ('insights', true, 'OPERATIONAL', 'Enable insights for this instance'),
  ('monthly-proration', false, 'RELEASE', 'Monthly aggregated seat proration for annual plans'),
  ('onboarding-v3', true, 'EXPERIMENT', 'Enable onboarding v3 for all users'),
  ('organizations', true, 'OPERATIONAL', 'Manage organizations with multiple teams'),
  ('organizer-request-email-v2', false, 'OPERATIONAL', 'Enable confirmation email with built-in rejection form'),
  ('pbac', true, 'OPERATIONAL', 'Enables the PBAC feature.'),
  ('restriction-schedule', false, 'RELEASE', NULL),
  ('salesforce-crm-tasker', false, 'OPERATIONAL', 'Whether to use tasker for Salesforce CRM event creation or not on a team/user basis.'),
  ('sidebar-tips', false, 'OPERATIONAL', 'Enables the tips section in the sidebar.'),
  ('signup-watchlist-review', false, 'OPERATIONAL', 'When enabled, new signups are added to the watchlist for review'),
  ('sink-shortener', false, 'OPERATIONAL', 'Enable Sink URL shortener for SMS workflows'),
  ('team-booking-page-cache', false, 'OPERATIONAL', 'Enable to cache event-type and team data for team booking pages'),
  ('teams', true, 'OPERATIONAL', 'Enable teams for this instance'),
  ('tiered-support-chat', false, 'OPERATIONAL', 'Enable Tiered Support Chat - Allow users to access different levels of support chat based on their subscription tier.'),
  ('use-api-v2-for-team-slots', false, 'OPERATIONAL', 'Whether to use API v2 for fetching team schedule slots.'),
  ('webhooks', true, 'OPERATIONAL', 'Enable webhooks for this instance'),
  ('workflow-smtp-emails', false, 'OPERATIONAL', 'Whether to use SMTP for workflow emails or SendGrid on a team/user basis.'),
  ('workflows', true, 'OPERATIONAL', 'Enable workflows for this instance')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "OutOfOfficeReason" ("emoji", "reason", "enabled")
VALUES
  ('🕒', 'ooo_reasons_unspecified', true),
  ('🏝️', 'ooo_reasons_vacation', true),
  ('🛫', 'ooo_reasons_travel', true),
  ('🤒', 'ooo_reasons_sick_leave', true),
  ('📅', 'ooo_reasons_public_holiday', true);

INSERT INTO "App" ("slug", "dirName", "keys", "categories", "enabled", "updatedAt")
VALUES
  ('daily-video', 'dailyvideo', NULL, '["video"]', true, strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'))
ON CONFLICT DO NOTHING;

INSERT INTO "AuditActor" ("id", "type", "userUuid", "attendeeId", "email", "phone", "name")
VALUES
  ('00000000-0000-0000-0000-000000000000', 'system', NULL, NULL, NULL, NULL, 'System')
ON CONFLICT ("id") DO NOTHING;

-- SQLite triggers cannot assign NEW, so the source's BEFORE trigger becomes an AFTER rewrite of the same row.
-- The CHECK on "role" makes the source's ELSE branch (keep customRoleId) unreachable.
CREATE TRIGGER "membership_role_change_insert_trigger"
AFTER INSERT ON "Membership"
BEGIN
    UPDATE "Membership"
    SET "customRoleId" = CASE NEW."role"
        WHEN 'OWNER' THEN 'owner_role'
        WHEN 'ADMIN' THEN 'admin_role'
        WHEN 'MEMBER' THEN 'member_role'
        ELSE NEW."customRoleId"
    END
    WHERE "id" = NEW."id";
END;

CREATE TRIGGER "membership_role_change_update_trigger"
AFTER UPDATE OF "role" ON "Membership"
BEGIN
    UPDATE "Membership"
    SET "customRoleId" = CASE NEW."role"
        WHEN 'OWNER' THEN 'owner_role'
        WHEN 'ADMIN' THEN 'admin_role'
        WHEN 'MEMBER' THEN 'member_role'
        ELSE NEW."customRoleId"
    END
    WHERE "id" = NEW."id";
END;
