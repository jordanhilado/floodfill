/** A row of mutually exclusive options (radio buttons styled as a segmented control). */
export function Segmented<T extends string>({
  name,
  options,
  value,
  onChange,
}: {
  name: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="mt-2 grid auto-cols-fr grid-flow-col gap-0.5 rounded-[8px] bg-fill p-0.5">
      {options.map((o) => (
        <label
          key={o.value}
          className={`flex h-8 cursor-pointer items-center justify-center rounded-[8px] text-13 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-done ${
            value === o.value ? 'bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]' : 'text-ink-2 hover:text-ink'
          }`}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </div>
  )
}
