-- Prince Edward Island: Employment Standards Act (RSPEI 1988, c E-6.3).
-- s.30(1): 2 weeks of vacation after each year of employment under 5 years, 3 weeks from 5 years of service.
-- s.1(1)(n) paid holidays: New Year's Day, Islander Day (3rd Monday of February), Good Friday, July 1,
-- Labour Day, National Day for Truth and Reconciliation (Sept 30), Remembrance Day, Christmas Day.
-- Weekend observance is not modelled (same simplification as other provinces).
begin;

create or replace function tymrak_private.is_public_holiday(p_province text, d date) returns boolean
language plpgsql immutable set search_path='' as $$
declare
  y int := extract(year from d)::int;
  good_friday date := tymrak_private.easter_sunday(y) - 2;
  family date := tymrak_private.nth_weekday(y,2,1,3);
  victoria date := (make_date(y,5,25) - ((extract(dow from make_date(y,5,25))::int+6)%7
                    + case when extract(dow from make_date(y,5,25))=1 then 7 else 0 end))::date;
  aug_first_mon date := tymrak_private.nth_weekday(y,8,1,1);
  labour date := tymrak_private.nth_weekday(y,9,1,1);
  thanks date := tymrak_private.nth_weekday(y,10,1,2);
  canada date := make_date(y,7,1);
  new_year date := make_date(y,1,1);
  remembrance date := make_date(y,11,11);
  christmas date := make_date(y,12,25);
  truth date := make_date(y,9,30);
begin
  if p_province in ('AB','QC','SK') and extract(dow from canada)=0 then canada := canada + 1; end if;
  return case p_province
    when 'ON' then d in (new_year,family,good_friday,victoria,canada,labour,thanks,christmas,make_date(y,12,26))
    when 'BC' then d in (new_year,family,good_friday,victoria,canada,aug_first_mon,labour,truth,thanks,remembrance,christmas)
    when 'AB' then d in (new_year,family,good_friday,victoria,canada,labour,thanks,remembrance,christmas)
    when 'SK' then d in (new_year,family,good_friday,victoria,canada,aug_first_mon,labour,thanks,remembrance,christmas)
    when 'MB' then d in (new_year,family,good_friday,victoria,canada,labour,truth,thanks,christmas)
    when 'QC' then d in (new_year,good_friday,victoria,make_date(y,6,24),canada,labour,thanks,christmas)
    when 'NB' then d in (new_year,family,good_friday,canada,aug_first_mon,labour,remembrance,christmas)
    when 'NS' then d in (new_year,family,good_friday,canada,labour,christmas)
    when 'PE' then d in (new_year,family,good_friday,make_date(y,7,1),labour,truth,remembrance,christmas)
    when 'NL' then d in (new_year,good_friday,canada,labour,remembrance,christmas)
    else false end;
end $$;

update public.time_off_province_policies
   set enabled = true,
       note = 'Employment Standards Act s.30: 2 weeks, 3 weeks from 5 years'
 where province = 'PE';
insert into public.time_off_policy_tiers(province, from_years, annual_days) values ('PE',0,10),('PE',5,15)
  on conflict (province, from_years) do update set annual_days = excluded.annual_days;

commit;
