# Despliegue con AWS SAM

Alternativa a `aws lambda-web deploy` (ver README principal): desplegar el agente como **Lambda Web Function** con infraestructura como código, usando el recurso [`AWS::Serverless::WebFunction`](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-resource-webfunction.html).

El `template.yaml` crea el rol de ejecución (mínimo privilegio: logs + Bedrock Nova + S3 de sesiones), los log groups con retención, la Web Function con su revisión y el endpoint HTTPS.

Para este recurso, `CodeUri` **debe apuntar a un objeto en S3**: `sam build` y `sam package` **no** empaquetan código local para una Web Function. Por eso el flujo no es el típico `sam build && sam deploy`, sino: compilar → empaquetar → subir el `.zip` a un bucket **versionado** → tomar el *version id* → desplegar.

El bucket de código, además, necesita una *bucket policy* que permita a `lambda.amazonaws.com` leer el objeto (`s3:GetObject`, `s3:GetObjectVersion`).

## Requisitos

- AWS SAM CLI (última versión) y AWS CLI v2 (reciente, con soporte `lambda-web`), con credenciales configuradas.
- Acceso al modelo **Amazon Nova** habilitado en la región (`us-east-1`).
- Un **bucket de código** versionado y un **bucket de sesiones** (pueden ser el mismo o distintos; aquí van separados).

## Paso a paso (bash / git bash)

Ejecutá todo **desde la raíz del subproyecto** (`agent-weather-sse/`), no desde `sam/`.

### 1. Compilar

```bash
npm install
npm run build   # genera dist/index.js
```

### 2. Crear los buckets (si no existen) y habilitar versioning en el de código

```bash
# Bucket de código-reemplaza lambdawebfunction-laub por un nombre unico (versionado, obligatorio para WebFunction)
aws s3 mb s3://lambdawebfunction-laub --region us-east-1
aws s3api put-bucket-versioning \
  --bucket lambdawebfunction-laub \
  --versioning-configuration Status=Enabled

# Bucket de sesiones--reemplaza sessions-llb por un nombre unico
aws s3 mb s3://sessions-llb --region us-east-1
```

Dale permiso de lectura al servicio Lambda sobre el bucket de código (política
inline, sin archivos temporales):

```bash
aws s3api put-bucket-policy --bucket lambdawebfunction-laub --policy "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": ["s3:GetObject", "s3:GetObjectVersion"],
    "Resource": "arn:aws:s3:::lambdawebfunction-laub/*"
  }]
}
EOF
)"
```

### 3. Empaquetar y subir el código a S3

El `.zip` debe tener `package.json`, `node_modules/` y `dist/` en su raíz, y ser un ZIP válido. Para no depender de `zip` (que git bash en Windows no trae) ni de `tar` (que en Windows no genera un ZIP real), usá el script [`sam/package.sh`](package.sh), que empaqueta con `Compress-Archive`:

```bash
bash sam/package.sh
```

Subí el zip y tomá su **version id** para el template:

```bash
aws s3 cp app.zip s3://lambdawebfunction-laub/weather-agent/app.zip

aws s3api head-object \
  --bucket lambdawebfunction-laub \
  --key weather-agent/app.zip \
  --query VersionId --output text
```

> `package.sh` corre `npm ci --omit=dev` (solo dependencias de producción). Tras subir, reinstalá las dev-dependencies para seguir desarrollando local: `npm install`. En Linux/macOS podés reemplazar el script por `zip -r app.zip package.json node_modules dist`.

### 4. Desplegar en AWS

Editá `sam/samconfig.toml` y reemplazá `CodeVersion` por el *version id* del paso anterior (y ajustá los nombres de bucket si usaste otros):

```bash
sam deploy --template-file sam/template.yaml --config-file sam/samconfig.toml
```

O pasando los parámetros en línea, sin tocar el `samconfig.toml`:

```bash
VERSION_ID=$(aws s3api head-object --bucket lambdawebfunction-laub \
  --key weather-agent/app.zip --query VersionId --output text)

sam deploy \
  --template-file sam/template.yaml \
  --stack-name weather-agent \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    CodeBucket=lambdawebfunction-laub \
    CodeKey=weather-agent/app.zip \
    CodeVersion="$VERSION_ID" \
    SessionBucket=sessions-llb \
    SessionPrefix=weather-agent/ \
    BedrockModelId=us.amazon.nova-2-lite-v1:0
```

Al terminar, el *output* `EndpointUrl` trae la URL HTTPS. Probala:

```bash
curl --ssl-no-revoke https://<endpoint>/health
# -> {"status":"healthy"}
```

### 5. Desplegar un cambio de código

Repetí el paso 3 (subí un `.zip` nuevo, tomá el nuevo *version id*) y volvé a hacer `sam deploy` con ese `CodeVersion`. Cambiar `CodeVersion` crea una revisión nueva que el endpoint sirve automáticamente (`LatestRevision`).

## 🧹 Limpieza del ambiente (IMPORTANTE!)

```bash
sam delete --stack-name weather-agent --region us-east-1
```

`sam delete` borra la Web Function, el endpoint, la revisión, el rol de ejecución y los *log groups*. Los **buckets** (código y sesiones) NO son parte del stack, así que se borran aparte.

El bucket de **sesiones** no tiene versioning, así que alcanza con vaciar y borrar:

```bash
aws s3 rm s3://sessions-llb --recursive && aws s3 rb s3://sessions-llb
```

El bucket de **código** tiene versioning, así que hay que borrar todas las versiones y los *delete markers* (puede que te dé error si no los hay) antes de eliminarlo:

```bash
CODE_BUCKET=lambdawebfunction-laub

aws s3api delete-objects --bucket "$CODE_BUCKET" \
  --delete "$(aws s3api list-object-versions --bucket "$CODE_BUCKET" \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json)"

# Delete markers (ignorá el error si no hay ninguno)
aws s3api delete-objects --bucket "$CODE_BUCKET" \
  --delete "$(aws s3api list-object-versions --bucket "$CODE_BUCKET" \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json)"

aws s3 rb "s3://$CODE_BUCKET"
```

## Notas

- `AuthType: ApplicationManaged` deja el endpoint **público**. Para exigir firma SigV4, cambialo a `IamAuth` en el template (los clientes necesitarán el permiso `lambda:InvokeWebFunctionEndpoint`).
- `Timeout` está en 300 s; el máximo de una Web Function es 900 s.
- La política de Bedrock usa `Resource: '*'` para simplificar; en producción conviene acotarla al ARN del modelo y del *inference profile*.
