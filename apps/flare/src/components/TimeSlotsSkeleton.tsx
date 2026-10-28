export function TimeSlotsSkeleton() {
  return (
    <div className="flex w-[20%] flex-col only:w-full">
      {Array.from({ length: Math.floor(Math.random() * 6) + 1 }).map((_, index) => (
        <span
          className="font-size-0 bg-emphasis inline-block animate-pulse rounded-md empty:before:inline-block empty:before:content-[''] mb-4 h-6 w-full"
          key={index}
        />
      ))}
    </div>
  );
}
