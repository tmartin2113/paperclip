type StatCardProps = {
  label: string;
  lifetime: string | number;
  sinceReset: string | number | null;
  resetAt: string | null;
};

export function StatCard({ label, lifetime, sinceReset, resetAt }: StatCardProps) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{lifetime}</div>
      {sinceReset !== null && resetAt !== null && (
        <div className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium">{sinceReset}</span>
          <span className="ml-1">since {new Date(resetAt).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
