# TALON Attendance — Public Showcase

This repository is a sanitized public edition of TALON's employee attendance system.

## Included

- Employee check-in/check-out web interface
- Supabase Edge Function API
- PostgreSQL schema with fictional demo records
- Geofencing, device binding, selfie verification, and payroll reporting foundations

## Not included

- Production credentials or environment secrets
- Real employee names, attendance records, selfies, or branch coordinates
- Production deployment configuration

## Setup

1. Create a new Supabase project.
2. Run `sql/01_schema_and_seed.sql` in the SQL editor.
3. Deploy `supabase/functions/api/index.ts` as an Edge Function named `api`.
4. Add a strong `ADMIN_PASSWORD` secret to the function environment.
5. Replace `YOUR_PROJECT` in `web/index.html` with your Supabase project reference.
6. Deploy `web/` to a static host.

## Security

Never commit service-role keys, passwords, employee data, photos, or precise production locations. This public repository uses fictional demo data only.

## License

Copyright (c) TALON. Source-available for portfolio and evaluation purposes. No permission is granted for commercial reuse, redistribution, or production deployment without written authorization.
