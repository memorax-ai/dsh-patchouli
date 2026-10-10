use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use patchouli_backend::ArtifactUploadBeginData;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Mutex,
};
use uuid::Uuid;

pub const MAX_ARTIFACT_CHUNK_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug)]
pub struct StoredArtifact {
    pub provider: String,
    pub key: String,
    pub byte_length: u64,
    pub digest: String,
}

#[derive(Debug)]
pub struct DownloadChunk {
    pub bytes_base64: String,
    pub byte_length: u64,
    pub next_offset: u64,
    pub eof: bool,
}

#[derive(Clone, Debug)]
struct Upload {
    data: ArtifactUploadBeginData,
    path: PathBuf,
    committed: Option<StoredArtifact>,
}

#[derive(Debug, Error)]
pub enum ArtifactStoreError {
    #[error("invalid artifact request: {0}")]
    Invalid(String),
    #[error("artifact upload or content was not found")]
    NotFound,
    #[error("artifact store I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

pub struct ArtifactStore {
    provider: String,
    objects: PathBuf,
    uploads: PathBuf,
    active_uploads: Mutex<BTreeMap<String, Upload>>,
}

impl ArtifactStore {
    pub async fn open(
        root: impl AsRef<Path>,
        provider: String,
    ) -> Result<Self, ArtifactStoreError> {
        if provider.trim().is_empty() {
            return Err(ArtifactStoreError::Invalid(
                "artifact provider must not be empty".to_owned(),
            ));
        }
        let root = root.as_ref();
        reject_symbolic_link_components(root)?;
        create_private_dir(root)?;
        let root = std::fs::canonicalize(root)?;
        let objects = root.join("objects");
        let uploads = root.join("uploads");
        create_private_dir(&objects)?;
        create_private_dir(&uploads)?;
        clear_incomplete_uploads(&uploads).await?;
        Ok(Self {
            provider,
            objects,
            uploads,
            active_uploads: Mutex::new(BTreeMap::new()),
        })
    }

    pub async fn begin(&self, data: ArtifactUploadBeginData) -> Result<String, ArtifactStoreError> {
        let upload_id = Uuid::new_v4().to_string();
        let path = self.uploads.join(format!("{upload_id}.part"));
        create_private_file(&path)?;
        self.active_uploads.lock().await.insert(
            upload_id.clone(),
            Upload {
                data,
                path,
                committed: None,
            },
        );
        Ok(upload_id)
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub async fn append(
        &self,
        upload_id: &str,
        offset: u64,
        bytes_base64: &str,
    ) -> Result<u64, ArtifactStoreError> {
        let bytes = BASE64.decode(bytes_base64).map_err(|_| {
            ArtifactStoreError::Invalid("bytes_base64 is not valid Base64".to_owned())
        })?;
        if bytes.is_empty() || bytes.len() > MAX_ARTIFACT_CHUNK_BYTES {
            return Err(ArtifactStoreError::Invalid(format!(
                "decoded chunk must contain 1 through {MAX_ARTIFACT_CHUNK_BYTES} bytes"
            )));
        }

        let uploads = self.active_uploads.lock().await;
        let upload = uploads.get(upload_id).ok_or(ArtifactStoreError::NotFound)?;
        if upload.committed.is_some() {
            return Err(ArtifactStoreError::Invalid(
                "artifact upload is already committed".to_owned(),
            ));
        }
        let current = fs::metadata(&upload.path).await?.len();
        if current != offset {
            return Err(ArtifactStoreError::Invalid(format!(
                "chunk offset {offset} does not match next offset {current}"
            )));
        }
        let next_offset = current
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| ArtifactStoreError::Invalid("artifact length overflow".to_owned()))?;
        if upload
            .data
            .expected_byte_length
            .is_some_and(|expected| next_offset > expected)
        {
            return Err(ArtifactStoreError::Invalid(
                "uploaded bytes exceed expected_byte_length".to_owned(),
            ));
        }
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&upload.path)
            .await?;
        file.write_all(&bytes).await?;
        file.flush().await?;
        Ok(next_offset)
    }

    pub async fn commit(
        &self,
        upload_id: &str,
    ) -> Result<(ArtifactUploadBeginData, StoredArtifact), ArtifactStoreError> {
        let mut uploads = self.active_uploads.lock().await;
        let upload = uploads
            .get_mut(upload_id)
            .ok_or(ArtifactStoreError::NotFound)?;
        if let Some(committed) = &upload.committed {
            return Ok((upload.data.clone(), committed.clone()));
        }

        let (byte_length, digest_hex) = hash_file(&upload.path).await?;
        if upload
            .data
            .expected_byte_length
            .is_some_and(|expected| expected != byte_length)
        {
            return Err(ArtifactStoreError::Invalid(format!(
                "uploaded byte length {byte_length} does not match expected_byte_length"
            )));
        }
        let digest = format!("sha256:{digest_hex}");
        if upload
            .data
            .expected_digest
            .as_ref()
            .is_some_and(|expected| expected != &digest)
        {
            return Err(ArtifactStoreError::Invalid(
                "uploaded content does not match expected_digest".to_owned(),
            ));
        }

        let key = format!("sha256/{digest_hex}");
        let directory = self.objects.join("sha256").join(&digest_hex[..2]);
        create_private_dir(&directory)?;
        let destination = directory.join(&digest_hex[2..]);
        match fs::symlink_metadata(&destination).await {
            Ok(metadata) if metadata.is_file() => {
                let (existing_length, existing_digest) = hash_file(&destination).await?;
                if existing_length != byte_length || existing_digest != digest_hex {
                    return Err(ArtifactStoreError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "managed artifact content failed integrity verification",
                    )));
                }
                fs::remove_file(&upload.path).await?;
            }
            Ok(_) => {
                return Err(ArtifactStoreError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "managed artifact key is not a regular file",
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let file = fs::OpenOptions::new()
                    .write(true)
                    .open(&upload.path)
                    .await?;
                file.sync_all().await?;
                fs::rename(&upload.path, &destination).await?;
            }
            Err(error) => return Err(error.into()),
        }

        let committed = StoredArtifact {
            provider: self.provider.clone(),
            key,
            byte_length,
            digest,
        };
        upload.committed = Some(committed.clone());
        Ok((upload.data.clone(), committed))
    }

    pub async fn finish(&self, upload_id: &str) {
        self.active_uploads.lock().await.remove(upload_id);
    }

    pub async fn read(
        &self,
        provider: &str,
        key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<DownloadChunk, ArtifactStoreError> {
        if provider != self.provider {
            return Err(ArtifactStoreError::Invalid(format!(
                "artifact is managed by provider {provider:?}, not {:?}",
                self.provider
            )));
        }
        let digest_hex = parse_key(key)?;
        let path = self
            .objects
            .join("sha256")
            .join(&digest_hex[..2])
            .join(&digest_hex[2..]);
        let metadata = fs::symlink_metadata(&path).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ArtifactStoreError::NotFound
            } else {
                error.into()
            }
        })?;
        if !metadata.is_file() {
            return Err(ArtifactStoreError::NotFound);
        }
        if offset > metadata.len() {
            return Err(ArtifactStoreError::Invalid(
                "download offset exceeds artifact byte length".to_owned(),
            ));
        }
        if max_bytes == 0 || max_bytes > MAX_ARTIFACT_CHUNK_BYTES as u64 {
            return Err(ArtifactStoreError::Invalid(format!(
                "max_bytes must be between 1 and {MAX_ARTIFACT_CHUNK_BYTES}"
            )));
        }
        let remaining = metadata.len() - offset;
        let read_length = remaining.min(max_bytes) as usize;
        let mut bytes = vec![0; read_length];
        let mut file = fs::File::open(path).await?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        file.read_exact(&mut bytes).await?;
        let next_offset = offset + read_length as u64;
        Ok(DownloadChunk {
            bytes_base64: BASE64.encode(bytes),
            byte_length: metadata.len(),
            next_offset,
            eof: next_offset == metadata.len(),
        })
    }
}

async fn hash_file(path: &Path) -> Result<(u64, String), std::io::Error> {
    let mut file = fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut byte_length = 0_u64;
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        byte_length += read as u64;
    }
    Ok((byte_length, hex::encode(hasher.finalize())))
}

fn parse_key(key: &str) -> Result<&str, ArtifactStoreError> {
    let digest = key.strip_prefix("sha256/").ok_or_else(|| {
        ArtifactStoreError::Invalid("managed artifact key must use sha256/<digest>".to_owned())
    })?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ArtifactStoreError::Invalid(
            "managed artifact key has an invalid SHA-256 digest".to_owned(),
        ));
    }
    Ok(digest)
}

fn create_private_dir(path: &Path) -> Result<(), std::io::Error> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{} must not be a symbolic link", path.display()),
            ));
        }
        Ok(metadata) if metadata.is_dir() => return validate_private_permissions(path),
        Ok(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("{} exists and is not a directory", path.display()),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    validate_private_permissions(path)
}

fn create_private_file(path: &Path) -> Result<(), std::io::Error> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map(|_| ())
}

fn reject_symbolic_link_components(path: &Path) -> Result<(), std::io::Error> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    && !symbolic_link_owner_is_trusted(&metadata) =>
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("{} must not contain symbolic links", path.display()),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn symbolic_link_owner_is_trusted(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    let owner = metadata.uid();
    // SAFETY: geteuid has no preconditions and does not retain pointers.
    owner == 0 || owner == unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
fn symbolic_link_owner_is_trusted(_metadata: &std::fs::Metadata) -> bool {
    false
}

async fn clear_incomplete_uploads(path: &Path) -> Result<(), ArtifactStoreError> {
    let mut entries = fs::read_dir(path).await?;
    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.file_type().await?;
        let name = entry.file_name();
        if !metadata.is_file() || !name.to_string_lossy().ends_with(".part") {
            return Err(ArtifactStoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "unexpected entry in artifact upload directory: {}",
                    entry.path().display()
                ),
            )));
        }
        fs::remove_file(entry.path()).await?;
    }
    Ok(())
}

#[cfg(unix)]
fn validate_private_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path)?.permissions().mode();
    if mode & 0o077 == 0 {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is accessible by group or other users", path.display()),
        ))
    }
}

#[cfg(not(unix))]
fn validate_private_permissions(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}
