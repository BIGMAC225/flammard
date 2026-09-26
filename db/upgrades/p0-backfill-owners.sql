-- Match existing free-text owners to people (case-insensitive full name,
-- alias, or unique first name). Unmatched text is left as it is.
update rocks x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update todos x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update meeting_rocks x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update scorecard_metrics x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update issues x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update steps x set owner_id = k.person_id, owner = k.name
from person_name_keys k
where x.owner_id is null and x.owner is not null and lower(btrim(x.owner)) = k.key;

update headlines x set presenter_id = k.person_id, presenter = k.name
from person_name_keys k
where x.presenter_id is null and x.presenter is not null and lower(btrim(x.presenter)) = k.key;

-- What is still unmatched (read-only report)
select 'rocks' as tbl, owner as text, count(*) from rocks where owner_id is null and owner is not null group by owner
union all select 'todos', owner, count(*) from todos where owner_id is null and owner is not null group by owner
union all select 'meeting_rocks', owner, count(*) from meeting_rocks where owner_id is null and owner is not null group by owner
union all select 'scorecard_metrics', owner, count(*) from scorecard_metrics where owner_id is null and owner is not null group by owner
union all select 'issues', owner, count(*) from issues where owner_id is null and owner is not null group by owner
union all select 'headlines', presenter, count(*) from headlines where presenter_id is null and presenter is not null group by presenter
order by 2;
