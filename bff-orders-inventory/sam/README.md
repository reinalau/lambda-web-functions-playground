# Despliegue unificado con AWS SAM

Un solo `template.yaml` despliega **todo el proyecto** en un stack. Recomiendo leer el template antes de desplegar.

## Limitación de WebFunction en SAM

`CodeUri` **debe apuntar a un objeto en S3**: `sam build`/`sam package` no
empaquetan código local para una Lambda Web Function. Por eso el flujo es: compilar
cada servicio → `zip` del artefacto → subir a un bucket **versionado** → tomar
el *version id* de cada uno → `sam deploy`. El bucket de código además necesita
una *bucket policy* que permita a `lambda.amazonaws.com` leer el objeto.

## Paso a paso (bash)

Ejecutá todo desde `bff-orders-inventory/`.

### 1. Compilar ambos servicios

```bash
(cd inventory && npm install && npm run build)
(cd orders && npm install && npm run build)
```

### 2. Crear el bucket de código (versionado) y darle acceso a Lambda

```bash
CODE_BUCKET=mi-bucket-de-codigo   # nombre único

aws s3 mb "s3://$CODE_BUCKET" --region us-east-1
aws s3api put-bucket-versioning --bucket "$CODE_BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-policy --bucket "$CODE_BUCKET" --policy "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": ["s3:GetObject", "s3:GetObjectVersion"],
    "Resource": "arn:aws:s3:::$CODE_BUCKET/*"
  }]
}
EOF
)"
```

### 3. Empaquetar y subir cada servicio

El `.zip` debe tener `package.json`, `node_modules/` y `dist/` en su raíz, y ser
un ZIP válido. Para no depender de `zip` (que git bash en Windows no trae) ni de
`tar` (que en Windows no genera un ZIP real), usá el script
[`sam/package.sh`](package.sh), que empaqueta ambos servicios con
`Compress-Archive`:

```bash
bash sam/package.sh
```

Subí los dos zips y capturá sus *version id*:

```bash
aws s3 cp inventory-app.zip "s3://$CODE_BUCKET/inventory/app.zip"
INVENTORY_VERSION=$(aws s3api head-object \
  --bucket "$CODE_BUCKET" --key inventory/app.zip --query VersionId --output text)

aws s3 cp orders-app.zip "s3://$CODE_BUCKET/orders/app.zip"
ORDERS_VERSION=$(aws s3api head-object \
  --bucket "$CODE_BUCKET" --key orders/app.zip --query VersionId --output text)
```

> `package.sh` corre `npm ci --omit=dev` en cada servicio (solo dependencias de
> producción). Tras subir, reinstalá las dev-dependencies para seguir
> desarrollando: `(cd inventory && npm install); (cd orders && npm install)`.
> En Linux/macOS podés reemplazar el script por
> `(cd inventory && zip -r ../inventory-app.zip package.json node_modules dist)`.

### 4. Desplegar todo el stack

Validar el template
```bash
sam validate --template-file sam/template.yaml
```

Deploy
```bash
sam deploy \
  --template-file sam/template.yaml \
  --stack-name bff-orders-inventory \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    CodeBucket="$CODE_BUCKET" \
    InventoryCodeKey=inventory/app.zip \
    InventoryCodeVersion="$INVENTORY_VERSION" \
    OrdersCodeKey=orders/app.zip \
    OrdersCodeVersion="$ORDERS_VERSION"
```

Al terminar, los *outputs* traen las URLs. Probá el BFF:

```bash
ORDERS_URL=$(aws cloudformation describe-stacks --stack-name bff-orders-inventory \
  --query "Stacks[0].Outputs[?OutputKey=='OrdersEndpointUrl'].OutputValue" --output text)

# Sembrá stock y hacé un pedido
aws dynamodb put-item --table-name inventory \
  --item '{"productId":{"S":"prod-1"},"productName":{"S":"Wireless mouse"},"available":{"N":"10"}}'

curl --ssl-no-revoke -X POST "$ORDERS_URL/orders" \
  -H "Content-Type: application/json" \
  -d '{"productId":"prod-1","quantity":2,"customer":"ada"}'
# -> 201
```

### 5. Desplegar un cambio

Recompilá, re-subí el `.zip` del servicio que cambió, tomá el nuevo *version id*
y volvé a `sam deploy` con ese valor. Cambiar el *version id* crea una revisión
nueva que el endpoint sirve automáticamente.

## Prueba de stress

```bash
ORDERS_DOMAIN=$(aws cloudformation describe-stacks --stack-name bff-orders-inventory \
  --query "Stacks[0].Outputs[?OutputKey=='OrdersEndpointUrl'].OutputValue" --output text \
  | sed 's#^https://##')
```

Scripts en [`load-test/`](load-test/), en bash puro con `curl` (no instalan nada). Corré todo desde la raíz del proyecto (`bff-orders-inventory/`), con `$ORDERS_DOMAIN` ya resuelto (el dominio sin `https://`). Primero sembrá un producto con mucho stock para que la carga no se agote; después dispará los pedidos.

```bash
# 1. Sembrar stock: productId "load-test" con 1.000.000 de unidades
bash load-test/seed-stock.sh

# 2. Marcar el inicio de la corrida (para acotar la consulta de CloudWatch)
RUN_START=$(date +%s)

# 3. Disparar la carga: 500 pedidos en total, 50 en paralelo
bash load-test/run-load.sh "$ORDERS_DOMAIN" 500 50

```

`run-load.sh <dominio> [total] [concurrencia]`: son `[total]` pedidos en total, con como mucho `[concurrencia]` en vuelo a la vez (no "500 concurrentes": 500 en total, 50 simultáneos).

Después, **esperá 1-2 minutos** a que los entornos escalen a cero (los reportes de CPU se emiten al cerrar el entorno) y medí **CPU activa, vida del entorno y costo de arranque** siguiendo [`load-test/cloudwatch-cpu-query.md`](load-test/cloudwatch-cpu-query.md). Usá el `RUN_START` del paso 2 como `--start-time` para no mezclar con corridas anteriores. La consulta es genérica y sirve para cualquier Web Function.


## Limpieza

```bash
sam delete --stack-name bff-orders-inventory --region us-east-1
```

El **bucket de código** NO es parte del stack (es un parámetro), así que se
borra aparte. Como tiene *versioning*, `aws s3 rm --recursive` no alcanza: hay
que borrar **todas las versiones** y los *delete markers* antes de eliminarlo:

```bash
# Borrar todas las versiones de objetos
aws s3api delete-objects --bucket "$CODE_BUCKET" \
  --delete "$(aws s3api list-object-versions --bucket "$CODE_BUCKET" \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json)"

# Borrar los delete markers (ignorá el error si no hay ninguno)
aws s3api delete-objects --bucket "$CODE_BUCKET" \
  --delete "$(aws s3api list-object-versions --bucket "$CODE_BUCKET" \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json)"

# Eliminar el bucket ya vacío
aws s3 rb "s3://$CODE_BUCKET"
```

> Si `sam delete` dejara algún *log group* sin borrar (por ejemplo si Lambda lo
> recreó tras un fallo), eliminalos a mano. En git bash en Windows,
> `MSYS_NO_PATHCONV=1` evita que la ruta `/aws/...` se convierta:

 ```bash
 for lg in /aws/lambda/web/inventory /aws/lambda/web/inventory.local \
           /aws/lambda/web/orders /aws/lambda/web/orders.local; do
   MSYS_NO_PATHCONV=1 aws logs delete-log-group --log-group-name "$lg" 2>/dev/null
 done
 ```

## Notas

- El endpoint de `inventory` se llama `prod` (default del recurso SAM), y el ARN
  del permiso en el template usa ese nombre. Si lo cambiás con `EndpointName`,
  ajustá también el `Resource` del `InvokeInventoryEndpoint`.
- `inventory` es `IamAuth` (privado) y `orders` es `ApplicationManaged`
  (público): se puede curlear `orders` directo, y este firma por dentro su
  llamada a `inventory`.
