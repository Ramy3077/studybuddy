-- The privileged-column trigger used to compare current_user with the literal
-- 'studybuddy_owner'. On managed Postgres the owner role has a different name
-- (e.g. `postgres`), which would block the server itself from upserting
-- privileged columns. Compare against whoever owns the profiles table instead:
-- that is the role that ran the migrations, i.e. "the server".
CREATE OR REPLACE FUNCTION protect_privileged_profile_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'profiles'::regclass) THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
       OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'privileged profile columns (id/email/role/password_hash) are not client-writable';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
