import { useState } from "react";

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>')}`;

export function MetaCases({ Block, duration, Scrollable }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <main className="mx-auto w-full max-w-[280px] space-y-4 rounded-xl border border-default bg-default p-6 text-default">
      <Block data-testid="empty" />
      <Block data-testid="zero">{0}</Block>
      <Block icon="clock" data-testid="duration">
        30 min
      </Block>
      <Block icon="globe">A long timezone description that wraps onto another line</Block>
      <Block icon="calendar" highlight>
        Thursday, January 10
      </Block>
      <Block
        icon="globe"
        customIcon={
          <span aria-hidden="true" className="mr-2">
            ✦
          </span>
        }
        data-testid="custom">
        Custom icon
      </Block>
      <Block iconUrl={image}>Default image</Block>
      <Block iconUrl={image} isDark={false}>
        Light image
      </Block>
      <Block iconUrl={image} isDark>
        Dark image
      </Block>
      <Block
        className="items-center"
        contentClassName="text-lg font-semibold"
        role="group"
        aria-label="Metadata props"
        title="Forwarded title"
        data-testid="props">
        Custom content
      </Block>
      {[undefined, 0, 1, 30, 59, 60, 61, 90, 120, 121, 480].map((minutes, index) => (
        <Block key={index} icon="clock" data-testid={`duration-${index}`}>
          {duration(minutes)}
        </Block>
      ))}
      <div>
        <Scrollable className="text-sm" ariaLabel="Short description">
          Short description
        </Scrollable>
        <Scrollable
          className={`overflow-y-auto whitespace-pre-wrap pr-4 text-sm ${expanded ? "max-h-none" : "max-h-[120px]"}`}
          ariaLabel="Long description">
          {Array.from({ length: 30 }, (_, index) => `Description line ${index + 1}`).join("\n")}
        </Scrollable>
        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse description" : "Expand description"}
        </button>
      </div>
    </main>
  );
}
