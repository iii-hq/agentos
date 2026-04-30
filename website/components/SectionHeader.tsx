type Props = {
  num: string;
  total?: string;
  label: string;
};

export default function SectionHeader({ num, total = "11", label }: Props) {
  return (
    <div className="flex items-baseline justify-between mb-10 pb-3 border-b border-line">
      <span className="eyebrow">§ {num} · {label}</span>
      <span className="page-counter">{num} / {total}</span>
    </div>
  );
}
