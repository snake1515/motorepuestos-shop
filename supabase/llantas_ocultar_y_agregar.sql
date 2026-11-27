update products set en_tienda = false
where category = 'Llantas' and code not in ('C300010','C300016','C300025','C300030','JKM300142','C300064','C300311','C300157','C300072','JKM302678','C300129','C300013','C300080','C300083','JKM300899','C300127','C300203','JKM300186','C300154','B300105','C300166','C300191','C300026','C300044','C300049','C300055','C300070','C300076','C300330','C300331','JKM300213','C300314','C300012','C300050','C300051','C300056','C300185','C300139','C300202','C300317','C300003','C300328','C300032','C300108','C300045','C300033','C300038','C300071','C300121','C300004','C300046','C300128','C300148','C300018','C300028','C300041','C300052','C300057','C300094','C300109','C300319','C300059','JKM300697','C300167','C300136','C300156','C300034','C300323','C300315','C300307','C300077','JKM300896','C300308','C300103','C300309','C300316','JKM300921','JKM300924','JKM302960','C300300','C300301','C300333','C300338','C300299','C300302','C300313','JKM300698','C300322','C300143','C300310','C300088','C300305','C300198','C300205','C300084','C300087','C300111','C300186','C300131','C300140','JKM300822','C300187','C300194','C300053','C300112','JKM300663','B300664','C300113','JKM300830','C300065','C300114','C300335','JKM300935','C300115','JKM300845','C300334','C300160','C300123','C300020','C300116','C300066','C300339','JKM300814','C300145','JKM300860','C300199','JKM300865','JKM300841','C300336','B300666','JKM300820','C300047','C300058','C300075','C300078','C300141','C300149','C300181','C300189','C300118','C300161','C300162','JKM300876','JKM300833','JKM300873','C300196','C300054','C300163','C300079');

insert into products (code, name, category, price, stock, image_url, marca, compatibilidad, en_tienda) values
('C300157','LLANTA 110/90-16 TL P-36A KINGSTONE','Llantas',109000,99,null,'Kingstone','Medida 110/90-16 · Tubeless (TL)',false),
('C300072','LLANTA 410-18 TT P-68 (TACO) KINGSTONE','Llantas',123900,99,null,'Kingstone','Medida 410-18 · Con neumático (TT) · Taco',false),
('C300026','LLANTA 275-18 TL P-126 (MT60) KINGSTONE','Llantas',91200,99,'/fotos/llantas/kingstone-p-126.webp','Kingstone','Medida 275-18 · Tubeless (TL)',true),
('C300051','LLANTA 300-18 TL P-190 (ESPINA MRF) KINGSTONE','Llantas',85900,99,'/fotos/llantas/kingstone-p-190.webp','Kingstone','Medida 300-18 · Tubeless (TL)',true),
('C300202','LLANTA 130/80-17 TL P-202 (DOB PROP) KINGSTONE','Llantas',169900,99,'/fotos/llantas/kingstone-p-202.webp','Kingstone','Medida 130/80-17 · Tubeless (TL) · Doble propósito',true),
('C300121','LLANTA 90/90-19 TT P-240 (DOB PROP) KINGSTONE','Llantas',86900,99,'/fotos/llantas/kingstone-p-240.webp','Kingstone','Medida 90/90-19 · Con neumático (TT) · Doble propósito',true),
('C300128','LLANTA 100/80-17 TL P-267 (LAGARTO) KINGSTONE','Llantas',114000,99,'/fotos/llantas/kingstone-p-267.webp','Kingstone','Medida 100/80-17 · Tubeless (TL) · Lagarto',true),
('C300057','LLANTA 300-18 TT P-267 (LAGARTO) KINGSTONE','Llantas',90000,99,'/fotos/llantas/kingstone-p-267.webp','Kingstone','Medida 300-18 · Con neumático (TT) · Lagarto',true),
('C300198','LLANTA 130/70-17 TL DS-01 (PISTA / PILOT) TIGER','Llantas',110000,99,'/fotos/llantas/tiger-ds-01.webp','Tiger','Medida 130/70-17 · Tubeless (TL) · Pistera',true),
('C300131','LLANTA 100/80-17 TL DS-03 (LAGARTO) TIGER','Llantas',87900,99,'/fotos/llantas/tiger-ds-03.webp','Tiger','Medida 100/80-17 · Tubeless (TL) · Lagarto',true),
('C300113','LLANTA 90/90-18 TL DS-06 (MT60) TIGER','Llantas',84900,99,'/fotos/llantas/tiger-ds-06.webp','Tiger','Medida 90/90-18 · Tubeless (TL)',true),
('C300058','LLANTA 300-18 TT DS-53 (TACO K270) TIGER','Llantas',70900,99,'/fotos/llantas/tiger-ds-53.webp','Tiger','Medida 300-18 · Con neumático (TT) · Taco',true),
('C300075','LLANTA 460-17 TT DS-53 (TACO K270) TIGER','Llantas',112900,99,'/fotos/llantas/tiger-ds-53.webp','Tiger','Medida 460-17 · Con neumático (TT) · Taco',true),
('C300149','LLANTA 110/80-17 TL DS-58 (MRF) TIGER','Llantas',101900,99,'/fotos/llantas/tiger-ds-58.webp','Tiger','Medida 110/80-17 · Tubeless (TL)',true),
('C300189','LLANTA 120/80-17 TL DS-58 (MRF) TIGER','Llantas',112500,99,'/fotos/llantas/tiger-ds-58.webp','Tiger','Medida 120/80-17 · Tubeless (TL)',true),
('C300054','LLANTA 300-18 TL DS-104 (DOB PROP) TIGER','Llantas',79900,99,'/fotos/llantas/tiger-ds-104.webp','Tiger','Medida 300-18 · Tubeless (TL) · Doble propósito',true)
on conflict (code) do update set
  name = excluded.name, category = excluded.category, price = excluded.price,
  image_url = coalesce(products.image_url, excluded.image_url), marca = excluded.marca,
  compatibilidad = excluded.compatibilidad, en_tienda = excluded.en_tienda;

select count(*) filter (where en_tienda) as publicadas, count(*) filter (where not en_tienda) as ocultas, count(*) as total
from products where category = 'Llantas';
