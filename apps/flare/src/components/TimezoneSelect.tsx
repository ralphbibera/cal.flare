import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { useMemo, useState } from "react";
import Select, { components, type InputProps, type OptionProps } from "react-select";
import { twMerge } from "tailwind-merge";
import { Icon } from "./Icon.tsx";
import { inputStyles } from "./Input.tsx";

dayjs.extend(utc);
dayjs.extend(timezone);

type Zone = { label: string; timezone: string };
type TimezoneOption = { value: string; label: string; offset: number };
type Props = {
  value: string;
  onChange: (value: string) => void;
  data: Zone[];
  label: string;
  disabled?: boolean;
};

export const timezoneAliases: Zone[] = [
  { label: "San Francisco", timezone: "America/Los_Angeles" },
  { label: "Sao Francisco do Sul", timezone: "America/Sao_Paulo" },
  { label: "San Francisco de Macoris", timezone: "America/Santo_Domingo" },
  { label: "San Francisco Gotera", timezone: "America/El_Salvador" },
  { label: "Eastern Time - US & Canada", timezone: "America/New_York" },
  { label: "Pacific Time - US & Canada", timezone: "America/Los_Angeles" },
  { label: "Central Time - US & Canada", timezone: "America/Chicago" },
  { label: "Mountain Time - US & Canada", timezone: "America/Denver" },
  { label: "Atlantic Time - Canada", timezone: "America/Halifax" },
  { label: "Eastern European Time", timezone: "Europe/Bucharest" },
  { label: "Central European Time", timezone: "Europe/Berlin" },
  { label: "Western European Time", timezone: "Europe/London" },
  { label: "Australian Eastern Time", timezone: "Australia/Sydney" },
  { label: "Japan Standard Time", timezone: "Asia/Tokyo" },
  { label: "India Standard Time", timezone: "Asia/Kolkata" },
  { label: "Gulf Standard Time", timezone: "Asia/Dubai" },
  { label: "South Africa Standard Time", timezone: "Africa/Johannesburg" },
  { label: "Brazil Time", timezone: "America/Sao_Paulo" },
  { label: "Hawaii-Aleutian Standard Time", timezone: "Pacific/Honolulu" },
];

function Option(props: OptionProps<TimezoneOption, false>) {
  return (
    <components.Option {...props}>
      <div className="flex items-center justify-between">
        <span className="w-full">{props.label}</span>
        {props.isSelected && <Icon name="check" className="ml-2 h-4 w-4" />}
      </div>
    </components.Option>
  );
}

function SelectInput(props: InputProps<TimezoneOption, false>) {
  return (
    <components.Input
      inputClassName="focus:ring-0 focus:ring-offset-0 !text-default dark:text-white!"
      {...props}
    />
  );
}

export function TimezoneSelect({ value, onChange, data, label, disabled }: Props) {
  const [search, setSearch] = useState("");
  const matches = useMemo(
    () => data.filter((zone) => search && zone.label.toLowerCase().includes(search.toLowerCase())),
    [data, search]
  );
  const timezones = useMemo(
    () => Object.fromEntries([...data, ...matches].map((zone) => [zone.timezone, zone.label])),
    [data, matches]
  );
  const options = Object.entries(timezones)
    .map(([value, label]) => ({ value, label, offset: dayjs().tz(value).utcOffset() }))
    .sort((left, right) => left.offset - right.offset);
  return (
    <Select<TimezoneOption>
      inputId="booker-time-zone"
      aria-label={label}
      isDisabled={disabled}
      value={options.find((option) => option.value === value) ?? null}
      options={options}
      onChange={(option) => {
        if (option) onChange(option.value);
      }}
      onInputChange={setSearch}
      menuPlacement="auto"
      unstyled
      components={{ Option, Input: SelectInput }}
      formatOptionLabel={(option) => <p className="truncate">{option.value.replaceAll("_", " ")}</p>}
      getOptionLabel={(option) => {
        const name = matches.length ? option.label : option.value.replaceAll("_", " ");
        const offset = dayjs()
          .tz(option.value)
          .format("Z")
          .replace(/^([-+])0(\d):00$/, "$1$2:00");
        return `${name} GMT ${offset}`;
      }}
      styles={{
        control: (base) => ({ ...base, minHeight: "36px", height: "36px" }),
        menuList: (base) => ({ ...base, height: "180px" }),
      }}
      classNames={{
        container: () => "max-w-full",
        input: () => "text-emphasis h-6 md:max-w-[145px] max-w-[250px]",
        option: (state) =>
          twMerge(
            "bg-default py-2.5 px-3 rounded-md text-default",
            state.isFocused && "bg-subtle",
            state.isSelected && "bg-emphasis text-default"
          ),
        placeholder: (state) => twMerge("text-muted", state.isFocused && "hidden"),
        dropdownIndicator: () => "text-default",
        control: () =>
          twMerge(
            inputStyles(),
            "h-9 py-0 px-3 rounded-[10px] min-h-0! p-0 w-full border-0 bg-transparent focus-within:ring-0 shadow-none!"
          ),
        singleValue: () => "text-emphasis placeholder:text-muted text-text py-1",
        valueContainer: () => "text-emphasis placeholder:text-muted flex gap-1",
        menu: (state) =>
          twMerge(
            "rounded-md bg-default text-sm leading-4 text-default mt-1 p-1 border border-subtle",
            state.selectProps.menuIsOpen && "shadow-dropdown",
            "w-64! max-w-[90vw] mb-1"
          ),
        menuList: () => "scroll-bar scrollbar-track-w-20 rounded-md flex flex-col space-y-1",
        indicatorsContainer: (state) =>
          twMerge(
            state.selectProps.menuIsOpen ? "rotate-180 transition-transform" : "text-default",
            "ml-auto"
          ),
        noOptionsMessage: () => "h-12 py-2 flex items-center justify-center",
      }}
    />
  );
}
