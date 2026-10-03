REPORT zdl_seed.

DATA config TYPE STANDARD TABLE OF zdl_config WITH EMPTY KEY.
DATA orders TYPE STANDARD TABLE OF zdl_order WITH EMPTY KEY.

config = VALUE #( ( currency = 'EUR' description = 'Euro' )
                  ( currency = 'USD' description = 'US dollar' ) ).
orders = VALUE #( ( order_id = '0000000001' customer = 'Contoso'   product = 'Widget' quantity = 5  currency = 'EUR' )
                  ( order_id = '0000000002' customer = 'Fabrikam'  product = 'Widget' quantity = 20 currency = 'EUR' )
                  ( order_id = '0000000003' customer = 'Northwind' product = 'Gadget' quantity = 20 currency = 'XYZ' ) ).

DELETE FROM zdl_config.
DELETE FROM zdl_order.
INSERT zdl_config FROM TABLE @config.
INSERT zdl_order FROM TABLE @orders.
COMMIT WORK.
WRITE: / |Seeded { lines( config ) } configuration rows and { lines( orders ) } orders.|.
