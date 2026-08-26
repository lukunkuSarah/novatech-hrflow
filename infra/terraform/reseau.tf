# =============================================================================
# Reseau
#
# Le systeme audite exposait ses cinq services sur toutes les interfaces, sans
# pare-feu documente : meme une passerelle correctement securisee aurait ete
# contournable en appelant directement les ports 3001 a 3004 (constat SEC-06).
#
# Ici, seul le repartiteur est joignable depuis Internet. Les services et la
# base vivent dans des sous-reseaux prives, sans adresse publique.
# =============================================================================

resource "aws_vpc" "principal" {
  cidr_block           = var.cidr_vpc
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "hrflow-${var.environnement}" }
}

# --- Sous-reseaux publics : uniquement le repartiteur et les passerelles NAT --
resource "aws_subnet" "public" {
  count = length(var.zones_disponibilite)

  vpc_id                  = aws_vpc.principal.id
  cidr_block              = cidrsubnet(var.cidr_vpc, 8, count.index)
  availability_zone       = var.zones_disponibilite[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "hrflow-${var.environnement}-public-${count.index}" }
}

# --- Sous-reseaux prives : services applicatifs ------------------------------
resource "aws_subnet" "prive" {
  count = length(var.zones_disponibilite)

  vpc_id            = aws_vpc.principal.id
  cidr_block        = cidrsubnet(var.cidr_vpc, 8, count.index + 10)
  availability_zone = var.zones_disponibilite[count.index]

  tags = { Name = "hrflow-${var.environnement}-prive-${count.index}" }
}

# --- Sous-reseaux de donnees : aucune route sortante -------------------------
# La base n'a aucun besoin de joindre Internet. Lui en donner la possibilite
# n'ajouterait qu'un chemin d'exfiltration.
resource "aws_subnet" "donnees" {
  count = length(var.zones_disponibilite)

  vpc_id            = aws_vpc.principal.id
  cidr_block        = cidrsubnet(var.cidr_vpc, 8, count.index + 20)
  availability_zone = var.zones_disponibilite[count.index]

  tags = { Name = "hrflow-${var.environnement}-donnees-${count.index}" }
}

resource "aws_internet_gateway" "principal" {
  vpc_id = aws_vpc.principal.id
  tags   = { Name = "hrflow-${var.environnement}" }
}

resource "aws_eip" "nat" {
  count  = length(var.zones_disponibilite)
  domain = "vpc"
  tags   = { Name = "hrflow-${var.environnement}-nat-${count.index}" }
}

# Une passerelle NAT par zone : une seule ferait de sa zone un point de panne
# unique pour tout le trafic sortant.
resource "aws_nat_gateway" "principal" {
  count = length(var.zones_disponibilite)

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.principal]

  tags = { Name = "hrflow-${var.environnement}-nat-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.principal.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.principal.id
  }

  tags = { Name = "hrflow-${var.environnement}-public" }
}

resource "aws_route_table" "prive" {
  count  = length(var.zones_disponibilite)
  vpc_id = aws_vpc.principal.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.principal[count.index].id
  }

  tags = { Name = "hrflow-${var.environnement}-prive-${count.index}" }
}

# Table sans route par defaut : les sous-reseaux de donnees ne sortent pas.
resource "aws_route_table" "donnees" {
  vpc_id = aws_vpc.principal.id
  tags   = { Name = "hrflow-${var.environnement}-donnees" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "prive" {
  count          = length(aws_subnet.prive)
  subnet_id      = aws_subnet.prive[count.index].id
  route_table_id = aws_route_table.prive[count.index].id
}

resource "aws_route_table_association" "donnees" {
  count          = length(aws_subnet.donnees)
  subnet_id      = aws_subnet.donnees[count.index].id
  route_table_id = aws_route_table.donnees.id
}

# =============================================================================
# Groupes de securite — chaque regle designe une source precise, jamais 0.0.0.0
# en dehors du repartiteur.
# =============================================================================

resource "aws_security_group" "repartiteur" {
  name        = "hrflow-${var.environnement}-alb"
  description = "Repartiteur de charge — seul point d'entree public"
  vpc_id      = aws_vpc.principal.id

  ingress {
    description = "HTTPS depuis Internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP — redirige vers HTTPS, jamais servi en clair (SEC-14)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "hrflow-${var.environnement}-alb" }
}

resource "aws_security_group" "services" {
  name        = "hrflow-${var.environnement}-services"
  description = "Services applicatifs — joignables depuis le repartiteur uniquement"
  vpc_id      = aws_vpc.principal.id

  # Aucune regle depuis Internet : c'est la correction structurelle du systeme
  # audite, ou les services ecoutaient sur toutes les interfaces.
  ingress {
    description     = "Trafic applicatif depuis le repartiteur"
    from_port       = 3000
    to_port         = 3004
    protocol        = "tcp"
    security_groups = [aws_security_group.repartiteur.id]
  }

  ingress {
    description = "Communication entre services du meme groupe"
    from_port   = 3000
    to_port     = 3004
    protocol    = "tcp"
    self        = true
  }

  ingress {
    description = "Metriques et sondes — reseau de supervision uniquement"
    from_port   = 3000
    to_port     = 3004
    protocol    = "tcp"
    cidr_blocks = [var.reseau_supervision]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "hrflow-${var.environnement}-services" }
}

resource "aws_security_group" "base" {
  name        = "hrflow-${var.environnement}-base"
  description = "PostgreSQL — joignable depuis les services uniquement"
  vpc_id      = aws_vpc.principal.id

  ingress {
    description     = "PostgreSQL depuis les services applicatifs"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.services.id]
  }

  # Aucune regle de sortie : la base n'a rien a joindre.

  tags = { Name = "hrflow-${var.environnement}-base" }
}
