-- Equivalencias entre como nombra el puerto un origen aduanero y ports.id.
--
-- El origen '*' vale para todos: son los nombres normalizados (mayusculas, sin
-- tildes) que aparecen igual en casi cualquier fichero colombiano. Cuando se
-- vea el fichero real y traiga CODIGOS de aduana en vez de nombres, se anaden
-- aqui con su propio `source`, sin tocar el cargador.
--
-- Lo que no resuelva se guarda con port_id NULL y se cuenta en el resumen de
-- carga. Nunca se descarta en silencio.

INSERT INTO customs_port_aliases (source, alias, port_id)
SELECT '*', a.alias, p.id
  FROM (VALUES
    ('CARTAGENA',              'COCTG'),
    ('CARTAGENA DE INDIAS',    'COCTG'),
    ('CONTECAR',               'COCTG'),  -- terminal dentro de la bahia
    ('MAMONAL',                'COCTG'),  -- idem
    ('SPRC',                   'COCTG'),
    ('BUENAVENTURA',           'COBUN'),
    ('BARRANQUILLA',           'COBAQ'),
    ('SANTA MARTA',            'COSMR'),
    ('PUERTO BOLIVAR',         'COPBO'),
    ('RIOHACHA',               'COPBO'),
    ('TURBO',                  'COTRB'),
    ('COVENAS',                'COCVE'),
    ('TUMACO',                 'COTCO'),
    ('SAN ANDRES',             'COADZ'),
    ('CIENAGA',                'COCIE'),
    -- Puertos extranjeros habituales como origen o destino.
    ('HOUSTON',                'USHOU'),
    ('MIAMI',                  'USMIA'),
    ('NUEVA YORK',             'USNYC'),
    ('NEW YORK',               'USNYC'),
    ('ROTTERDAM',              'NLRTM'),
    ('AMBERES',                'BEANR'),
    ('ANTWERP',                'BEANR'),
    ('HAMBURGO',               'DEHAM'),
    ('HAMBURG',                'DEHAM'),
    ('VALENCIA',               'ESVLC'),
    ('ALGECIRAS',              'ESALG'),
    ('BARCELONA',              'ESBCN'),
    ('SHANGHAI',               'CNSHA'),
    ('SHENZHEN',               'CNSZX'),
    ('NINGBO',                 'CNNGB'),
    ('HONG KONG',              'HKHKG'),
    ('BUSAN',                  'KRPUS'),
    ('SINGAPUR',               'SGSIN'),
    ('SINGAPORE',              'SGSIN'),
    ('BALBOA',                 'PABLB'),
    ('COLON',                  'PACOL'),
    ('MANZANILLO',             'MXZLO'),
    ('VERACRUZ',               'MXVER'),
    ('CALLAO',                 'PECLL'),
    ('SANTOS',                 'BRSSZ'),
    ('VALPARAISO',             'CLVAP'),
    ('SAN ANTONIO',            'CLSAI')
  ) AS a(alias, unlocode)
  JOIN ports p ON p.unlocode = a.unlocode
ON CONFLICT (source, alias) DO UPDATE SET port_id = EXCLUDED.port_id;
