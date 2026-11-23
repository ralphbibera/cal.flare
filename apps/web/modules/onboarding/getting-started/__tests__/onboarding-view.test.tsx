import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOnboardingStore } from "../../store/onboarding-store";
import { OnboardingView } from "../onboarding-view";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/onboarding/getting-started",
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock("posthog-js", () => ({
  default: {
    capture: vi.fn(),
  },
}));

vi.mock("@calcom/lib/hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../components/OnboardingLayout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../components/onboarding-continuation-prompt", () => ({
  OnboardingContinuationPrompt: () => null,
}));

describe("OnboardingView", () => {
  beforeEach(() => {
    pushMock.mockReset();
    useOnboardingStore.getState().resetOnboarding();
  });

  it("renders only the free personal plan and omits commercial team and organization plans", () => {
    render(<OnboardingView userEmail="user@example.com" />);

    expect(screen.getByText("onboarding_plan_personal_title")).toBeInTheDocument();
    expect(screen.getAllByText("onboarding_plan_personal_badge").length).toBeGreaterThan(0);
    expect(screen.queryByText("onboarding_plan_team_title")).not.toBeInTheDocument();
    expect(screen.queryByText("onboarding_plan_team_badge")).not.toBeInTheDocument();
    expect(screen.queryByText("onboarding_plan_organization_title")).not.toBeInTheDocument();
  });

  it("normalizes a persisted team selection to personal and navigates to personal settings", () => {
    useOnboardingStore.getState().setSelectedPlan("team");

    render(<OnboardingView userEmail="user@example.com" />);

    fireEvent.click(screen.getByTestId("onboarding-continue-btn"));

    expect(useOnboardingStore.getState().selectedPlan).toBe("personal");
    expect(pushMock).toHaveBeenCalledWith("/onboarding/personal/settings");
    expect(pushMock).not.toHaveBeenCalledWith("/onboarding/teams/details");
  });
});
