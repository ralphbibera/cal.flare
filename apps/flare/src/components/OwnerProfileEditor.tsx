import { type FormEvent, useEffect, useRef, useState } from "react";
import { BookerClient } from "../client/bookings.ts";
import type { OwnerProfile } from "../domain/profile.ts";
import { PROFILE_BIO_LIMIT, PROFILE_NAME_LIMIT, parseProfile } from "../domain/profile.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { TextArea } from "./TextArea.tsx";

type Labels = Record<
  "heading" | "name" | "bio" | "help" | "save" | "saved" | "invalid" | "failed" | "javascript",
  string
>;

export function OwnerProfileEditor({ initial, labels }: { initial: OwnerProfile; labels: Labels }) {
  const [name, setName] = useState(initial.displayName ?? "");
  const [bio, setBio] = useState(initial.bio);
  const [stage, setStage] = useState<"loading" | "idle" | "saving" | "saved" | "invalid" | "failed">(
    "loading"
  );
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setName(initial.displayName ?? "");
    setBio(initial.bio);
    setStage("idle");
    return () => {
      generation.current++;
      request.current?.abort();
      request.current = null;
    };
  }, [initial]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (request.current || stage === "loading") return;
    try {
      void save(parseProfile({ displayName: name, bio }));
    } catch {
      setStage("invalid");
    }
  }

  async function save(profile: OwnerProfile): Promise<void> {
    const controller = new AbortController();
    request.current = controller;
    const ticket = generation.current;
    setStage("saving");
    try {
      await new BookerClient().ownerSaveProfile(profile, controller.signal);
      if (ticket !== generation.current || controller.signal.aborted) return;
      setName(profile.displayName ?? "");
      setStage("saved");
    } catch {
      if (ticket === generation.current && !controller.signal.aborted) setStage("failed");
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  return (
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <h1 id="profile-heading" className="font-semibold text-emphasis text-xl">
        {labels.heading}
      </h1>
      <p id="profile-help" className="text-sm text-subtle">
        {labels.help}
      </p>
      <form aria-labelledby="profile-heading" onSubmit={submit}>
        <fieldset disabled={stage === "loading" || stage === "saving"} className="min-w-0 space-y-4">
          <div>
            <Label htmlFor="profile-name">{labels.name}</Label>
            <Input
              id="profile-name"
              className="min-w-0"
              maxLength={PROFILE_NAME_LIMIT}
              value={name}
              aria-describedby="profile-help"
              onChange={(event) => {
                generation.current++;
                setName(event.currentTarget.value);
                setStage("idle");
              }}
            />
          </div>
          <div>
            <Label htmlFor="profile-bio">{labels.bio}</Label>
            <TextArea
              id="profile-bio"
              className="min-w-0 leading-normal"
              rows={6}
              maxLength={PROFILE_BIO_LIMIT}
              value={bio}
              aria-describedby="profile-help"
              onChange={(event) => {
                generation.current++;
                setBio(event.currentTarget.value);
                setStage("idle");
              }}
            />
          </div>
          <Button type="submit" loading={stage === "saving"}>
            {labels.save}
          </Button>
        </fieldset>
        {stage === "saved" && (
          <p role="status" className="mt-3">
            {labels.saved}
          </p>
        )}
        {(stage === "invalid" || stage === "failed") && (
          <p role="alert" className="mt-3">
            {labels[stage]}
          </p>
        )}
      </form>
      <noscript>{labels.javascript}</noscript>
    </section>
  );
}
