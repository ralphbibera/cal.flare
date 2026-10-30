import assert from "node:assert/strict";

export async function verifyMeetingLocationPrivacy(fixture) {
  const owner = await fixture.login();
  const marker = "private-location-ssr-marker";
  const location = `${marker}\r\n東京 😀 <img src="/private-location-probe" onerror="alert(1)">`;
  const settings = { ...fixture.settings, event: { ...fixture.settings.event, location } };
  const slots = `/api/slots?${new URLSearchParams({
    from: new Date(Date.now() + 86_400_000).toISOString(),
    to: new Date(Date.now() + 172_800_000).toISOString(),
    timeZone: "UTC",
  })}`;
  assert.equal((await fixture.send("/api/owner", settings, owner, "PUT")).status, 200);
  const authorized = await fixture.read(await fixture.request("/api/owner", { headers: owner }));
  assert.ok(authorized.settings.event.location === location);
  for (const [path, status] of [
    ["/api/public", 200],
    [`/${settings.event.slug}`, 200],
    ["/missing-event", 404],
    [slots, 200],
    ["/api/slots?timeZone=invalid", 400],
    ["/api/owner", 401],
    ["/api/owner/bookings/missing", 401],
    ["/", 200],
    ["/owner/bookings", 200],
    ["/owner/bookings/missing", 200],
  ]) {
    const response = await fixture.request(path);
    assert.equal(response.status, status, path);
    const text = await response.text();
    assert.equal(text.includes(marker), false, `location redacted from ${path}`);
    assert.equal(text.includes("private-location-probe"), false);
    if (path === `/${settings.event.slug}`) assert.ok(text.includes("<astro-island"));
    if (path === "/api/public") assert.equal(Object.hasOwn(JSON.parse(text).event, "location"), false);
  }
  assert.equal(fixture.google.writes.length, 0);
  assert.deepEqual(fixture.upstreamFailures, []);
  console.log(
    "PASS private location owner API and public JSON/SSR/hydration redaction. Built Worker/local D1; Google is mocked."
  );
}
